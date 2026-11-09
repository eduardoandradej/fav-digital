import pg from 'pg';
import type { AppConfig } from '../config.js';

// timestamptz sempre como string ISO-8601 em UTC na API.
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
// numeric como número (apenas coordenadas usam numeric).
pg.types.setTypeParser(1700, (v: string) => Number(v));
// bigint (ids das trilhas) como número: limites muito acima do volume previsto.
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Tx = pg.PoolClient;

export class Database {
  readonly pool: pg.Pool;

  constructor(cfg: AppConfig['db']) {
    this.pool = new pg.Pool({
      connectionString: cfg.connectionString,
      max: cfg.poolMax,
      statement_timeout: cfg.statementTimeoutMs,
      application_name: 'fav-digital-api',
      options: '-c search_path=fav -c timezone=UTC',
    });
  }

  async query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  /**
   * Executa `fn` em uma transação. Transição de estado, evento, histórico e projeção
   * são gravados juntos; qualquer falha antes do commit desfaz tudo.
   */
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
