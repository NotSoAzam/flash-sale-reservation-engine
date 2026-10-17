import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  host: env.DATABASE_URL ? undefined : env.DB_HOST,
  port: env.DATABASE_URL ? undefined : env.DB_PORT,
  user: env.DATABASE_URL ? undefined : env.DB_USER,
  password: env.DATABASE_URL ? undefined : env.DB_PASSWORD,
  database: env.DATABASE_URL ? undefined : env.DB_NAME,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL Pool Error on idle client:', err);
});

export async function query<R extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<R>> {
  const start = Date.now();
  const res = await pool.query<R>(text, params);
  const duration = Date.now() - start;
  if (duration > 500) {
    console.warn(`⚠️ Slow query (${duration}ms): ${text.slice(0, 100)}`);
  }
  return res;
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDbHealth(): Promise<boolean> {
  try {
    const res = await pool.query('SELECT 1 as health_check');
    return res.rows[0].health_check === 1;
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('❌ PostgreSQL Health Check Failed:', error);
    }
    return false;
  }
}

export async function closeDbPool(): Promise<void> {
  await pool.end();
}
