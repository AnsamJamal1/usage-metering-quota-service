import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app';

const app = buildApp();
let apiKey: string;
let plan1Id: string;
let plan2Id: string;

beforeAll(async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { name: 'Plan Change Test' } });
  apiKey = res.json().apiKey;

  const p1 = await app.inject({
    method: 'POST', url: '/v1/plans', headers: { 'x-api-key': apiKey },
    payload: { name: 'Plan A', scope: 'user', monthlyAllowance: 100, maxPerRequest: 100 }
  });
  plan1Id = p1.json().id;

  const p2 = await app.inject({
    method: 'POST', url: '/v1/plans', headers: { 'x-api-key': apiKey },
    payload: { name: 'Plan B', scope: 'user', monthlyAllowance: 200, maxPerRequest:100 }
  });
  plan2Id = p2.json().id;

  await app.inject({
    method: 'POST', url: '/v1/users', headers: { 'x-api-key': apiKey },
    payload: { externalId: 'u1', planId: plan1Id }
  });

  await app.inject({
    method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey },
    payload: { userId: 'u1', units: 60, requestId: 'r1' }
  });
});

describe('Plan Changes and Edge Cases', () => {
  
  it('switching to a larger plan preserves consumed units', async () => {
    await app.inject({
      method: 'PUT', url: '/v1/users/u1/plan', headers: { 'x-api-key': apiKey },
      payload: { planId: plan2Id }
    });

    const consumeRes = await app.inject({
      method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey },
      payload: { userId: 'u1', units: 10, requestId: 'r2' }
    });

    const body = consumeRes.json();
    expect(body.accepted).toBe(true);
    
    expect(body.remaining.user).toBe(130);
  });

  it('reducing the allowance below current usage results in zero remaining and rejects new requests', async () => {
    await app.inject({
      method: 'PATCH', url: `/v1/plans/${plan2Id}`, headers: { 'x-api-key': apiKey },
      payload: { monthlyAllowance: 30 }
    });

    const usageRes = await app.inject({ method: 'GET', url: '/v1/usage/users/u1', headers: { 'x-api-key': apiKey } });
    const usage = usageRes.json();
    
    expect(usage.consumed).toBe(70);
    expect(usage.monthlyAllowance).toBe(30);
    expect(usage.remaining).toBe(0); 

    const consumeRes = await app.inject({
      method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey },
      payload: { userId: 'u1', units: 1, requestId: 'r3' }
    });
    
    const body = consumeRes.json();
    expect(body.accepted).toBe(false);
    expect(body.reason.level).toBe('user');
    expect(body.reason.rule).toBe('monthly_allowance');
  });

  it('past request history is preserved unchanged even after plan modifications', async () => {
    const historyRes = await app.inject({ method: 'GET', url: '/v1/requests?userId=u1', headers: { 'x-api-key': apiKey } });
    const history = historyRes.json().data;

    const firstReq = history.find((r: any) => r.requestId === 'r1');
    expect(firstReq).toBeDefined();
    
    expect(firstReq.status).toBe('accepted');
    
    expect(firstReq.units).toBe(60);
  });

  it('restoring the allowance allows consumption again', async () => {
    await app.inject({
      method: 'PATCH', url: `/v1/plans/${plan2Id}`, headers: { 'x-api-key': apiKey },
      payload: { monthlyAllowance: 100 }
    });

    const consumeRes = await app.inject({
      method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey },
      payload: { userId: 'u1', units: 10, requestId: 'r4' }
    });

    const body = consumeRes.json();
    expect(body.accepted).toBe(true);
    expect(body.remaining.user).toBe(20); 
  });
});
