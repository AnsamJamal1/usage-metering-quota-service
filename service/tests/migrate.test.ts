import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db';
import { migrate } from '../src/migrate';
import { seed } from '../src/seed';

afterAll(async () => {
  await pool.end();
});

describe('migrations and seed', () => {
  it('creates all tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['accounts', 'plans', 'users', 'account_usage', 'user_usage', 'requests']) {
      expect(names).toContain(t);
    }
  });

  it('seeds the four predefined plans', async () => {
    const { rows } = await pool.query(
      `SELECT name, scope, monthly_allowance, max_per_request
       FROM plans WHERE is_predefined ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['Basic', 'Premium', 'Pro', 'Starter']);
    const starter = rows.find((r) => r.name === 'Starter');
    expect(starter).toMatchObject({ scope: 'account', monthly_allowance: 10000, max_per_request: 100 });
  });

  it('is idempotent: running migrate and seed again changes nothing', async () => {
    await migrate();
    await seed();
    await seed();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM plans WHERE is_predefined`);
    expect(rows[0].n).toBe(4);
  });

  it('rejects a predefined plan that belongs to an account', async () => {
    await expect(
      pool.query(
        `INSERT INTO plans (account_id, scope, name, is_predefined)
         VALUES (gen_random_uuid(), 'user', 'Bad', true)`,
      ),
    ).rejects.toThrow();
  });
});
