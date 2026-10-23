import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db';
import { hashApiKey } from '../src/apiKey';
import { PLAN_IDS } from '../src/seed';

const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function createAccount(name: string, planId?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    payload: { name, planId },
  });
  return res;
}

describe('account creation', () => {
  it('creates an account with the default Starter plan and returns an API key once', async () => {
    const res = await createAccount('Acme');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.apiKey).toMatch(/^qk_/);
    expect(body.account.planId).toBe(PLAN_IDS.starter);
  });

  it('stores only a hash of the key, never the key itself', async () => {
    const { apiKey, account } = (await createAccount('Hash Check')).json();
    const { rows } = await pool.query('SELECT api_key_hash FROM accounts WHERE id = $1', [account.id]);
    expect(rows[0].api_key_hash).toBe(hashApiKey(apiKey));
    expect(rows[0].api_key_hash).not.toContain(apiKey);
  });

  it('accepts the Pro plan', async () => {
    const res = await createAccount('Big Co', PLAN_IDS.pro);
    expect(res.statusCode).toBe(201);
    expect(res.json().account.planId).toBe(PLAN_IDS.pro);
  });

  it('rejects an empty name with a validation error', async () => {
    const res = await createAccount('   ');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('rejects a user-scope plan as an account plan', async () => {
    const res = await createAccount('Wrong Plan', PLAN_IDS.basic);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_plan');
  });

  it('rejects an unknown plan id', async () => {
    const res = await createAccount('Ghost Plan', '11111111-1111-4111-8111-111111111111');
    expect(res.statusCode).toBe(400);
  });
});

describe('API key validation', () => {
  it('rejects a request without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/account' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_api_key');
  });

  it('rejects an invalid key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { 'x-api-key': 'qk_not-a-real-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
  });

  it('accepts a valid key and returns the account with its plan', async () => {
    const { apiKey, account } = (await createAccount('Valid Key Co')).json();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: account.id,
      plan: { name: 'Starter', monthlyAllowance: 10000, maxPerRequest: 100 },
    });
  });
});

describe('account isolation', () => {
  it('each key only sees its own account', async () => {
    const a = (await createAccount('Account A')).json();
    const b = (await createAccount('Account B', PLAN_IDS.pro)).json();

    const resA = await app.inject({ method: 'GET', url: '/v1/account', headers: { 'x-api-key': a.apiKey } });
    const resB = await app.inject({ method: 'GET', url: '/v1/account', headers: { 'x-api-key': b.apiKey } });

    expect(resA.json().id).toBe(a.account.id);
    expect(resB.json().id).toBe(b.account.id);
    expect(resA.json().plan.name).toBe('Starter');
    expect(resB.json().plan.name).toBe('Pro');
  });
});
