import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db';

const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('health', () => {
  it('returns ok when the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
