import { Pool, PoolClient, types } from 'pg';
import { config } from './config';


types.setTypeParser(20, (v) => Number(v));

types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
});
pool.on('error', (err) => {
  console.error('Unexpected idle client error', err.message);
});

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
