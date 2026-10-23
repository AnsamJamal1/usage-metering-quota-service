import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db';

const app = buildApp();
let apiKey: string;
let accountId: string;

beforeAll(async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { name: 'Usage Test' } });
  const data = res.json();
  apiKey = data.apiKey;
  accountId = data.account.id;

  await app.inject({ 
    method: 'POST', url: '/v1/users', headers: { 'x-api-key': apiKey }, 
    payload: { externalId: 'u1' } 
  });

  await app.inject({
    method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey },
    payload: { userId: 'u1', units: 15, requestId: 'u-1' } 
  });
  await app.inject({
    method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey },
    payload: { userId: 'u1', units: 30, requestId: 'u-2' } 
  });
});

afterAll(async () => {
});

describe('Usage and History APIs', () => {
  it('returns current usage for account and users', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/usage', headers: { 'x-api-key': apiKey }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    
    expect(body.account.consumed).toBe(15);
    expect(body.account.remaining).toBe(9985);

    expect(body.users).toHaveLength(1);
    expect(body.users[0].externalId).toBe('u1');
    expect(body.users[0].consumed).toBe(15);
    expect(body.users[0].remaining).toBe(985);
  });

  it('returns history of requests with pagination', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/requests?limit=1&offset=0', headers: { 'x-api-key': apiKey }
    });
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(1); 
    
    expect(body.data[0].requestId).toBe('u-2');
    expect(body.data[0].status).toBe('rejected');
    expect(body.data[0].reason.level).toBe('user');
  });

  it('filters history by status', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/requests?status=accepted', headers: { 'x-api-key': apiKey }
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.data[0].requestId).toBe('u-1');
  });

  it('shows zero usage for a past month that had no activity', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/usage?month=2025-01', headers: { 'x-api-key': apiKey }
    });
    const body = res.json();
    expect(body.account.consumed).toBe(0);
    expect(body.users[0].consumed).toBe(0);
  });

  it('allows querying past month usage after manually inserting data', async () => {
    const pastPeriod = '2025-01-01';
    await pool.query(`INSERT INTO account_usage (account_id, period, consumed) VALUES ($1, $2, 500)`, [accountId, pastPeriod]);
    await pool.query(`INSERT INTO user_usage (user_id, period, consumed) VALUES ((SELECT id FROM users WHERE external_id='u1' AND account_id = $2), $1, 100)`, [pastPeriod, accountId]);
    const res = await app.inject({
      method: 'GET', url: '/v1/usage?month=2025-01', headers: { 'x-api-key': apiKey }
    });
    const body = res.json();
    expect(body.account.consumed).toBe(500);
    expect(body.users[0].consumed).toBe(100);
  });
});
