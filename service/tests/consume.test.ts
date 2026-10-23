import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db';
import { PLAN_IDS } from '../src/seed';
import { evaluate } from '../src/rules/evaluate';

const app = buildApp();
let apiKey: string;
let accountId: string;
let basicUserId: string;
let premiumUserId: string;

beforeAll(async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { name: 'Test Quota' } });
  const data = res.json();
  apiKey = data.apiKey;
  accountId = data.account.id;

  const u1 = await app.inject({ method: 'POST', url: '/v1/users', headers: { 'x-api-key': apiKey }, payload: { externalId: 'user-basic' } });
  basicUserId = u1.json().externalId;

  const u2 = await app.inject({ method: 'POST', url: '/v1/users', headers: { 'x-api-key': apiKey }, payload: { externalId: 'user-prem', planId: PLAN_IDS.premium } });
  premiumUserId = u2.json().externalId;
});

describe('Rules Engine (Pure Function)', () => {
  it('rejects if user per-request limit exceeded', () => {
    const res = evaluate({
      units: 25,
      account: { limits: { monthly: 10000, perRequest: 100 }, consumed: 0 },
      user: { limits: { monthly: 1000, perRequest: 20 }, consumed: 0 },
    });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason.level).toBe('user');
  });
});

describe('Consume API', () => {
  it('accepts a valid request and increments both counters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consume',
      headers: { 'x-api-key': apiKey },
      payload: { userId: basicUserId, units: 10, requestId: 'req-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(body.remaining.user).toBe(990);
    expect(body.remaining.account).toBe(9990);
  });

  it('rejects if user per-request limit exceeded', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consume',
      headers: { 'x-api-key': apiKey },
      payload: { userId: basicUserId, units: 25, requestId: 'req-2' }, 
    });
    expect(res.json().accepted).toBe(false);
    expect(res.json().reason).toEqual({ level: 'user', rule: 'max_per_request', limit: 20 });
  });

  it('rejects if account limit exceeded (account has 10000, simulated here)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consume',
      headers: { 'x-api-key': apiKey },
      payload: { userId: premiumUserId, units: 200, requestId: 'req-3' }, 
    });
    expect(res.json().accepted).toBe(false);
    expect(res.json().reason.level).toBe('account');
    expect(res.json().reason.rule).toBe('max_per_request');
  });

  it('handles idempotency (replays the same response)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consume',
      headers: { 'x-api-key': apiKey },
      payload: { userId: basicUserId, units: 10, requestId: 'req-1' }, 
    });
    expect(res.json().accepted).toBe(true);
    expect(res.json().replayed).toBe(true);
    expect(res.json().remaining.user).toBe(990); 
  });

  it('fails with 409 if same requestId but different payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consume',
      headers: { 'x-api-key': apiKey },
      payload: { userId: basicUserId, units: 15, requestId: 'req-1' }, 
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_conflict');
  });

  it('handles concurrency correctly without exceeding limits', async () => {
    const cAcc = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { name: 'Concurrent' } });
    const cKey = cAcc.json().apiKey;
    
    const pRes = await app.inject({ method: 'POST', url: '/v1/plans', headers: { 'x-api-key': cKey }, payload: { name: 'Tiny', scope: 'user', monthlyAllowance: 50, maxPerRequest: 10 } });
    const planId = pRes.json().id;
    
    await app.inject({ method: 'POST', url: '/v1/users', headers: { 'x-api-key': cKey }, payload: { externalId: 'c-user', planId } });

    const promises = Array.from({ length: 10 }).map((_, i) => 
      app.inject({
        method: 'POST',
        url: '/v1/consume',
        headers: { 'x-api-key': cKey },
        payload: { userId: 'c-user', units: 10, requestId: `con-${i}` },
      })
    );
    
    const results = await Promise.all(promises);
    const accepted = results.filter(r => r.json().accepted).length;
    const rejected = results.filter(r => !r.json().accepted).length;

    expect(accepted).toBe(5);
    expect(rejected).toBe(5);
    
    const dbCheck = await pool.query(`SELECT consumed FROM user_usage WHERE user_id = (SELECT id FROM users WHERE external_id='c-user' AND account_id = '${cAcc.json().account.id}')`);
    expect(Number(dbCheck.rows[0].consumed)).toBe(50);
  });
});
