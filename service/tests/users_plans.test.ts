import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db';

const app = buildApp();
let accountA: { apiKey: string; id: string };
let accountB: { apiKey: string; id: string };

beforeAll(async () => {
  const resA = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { name: 'Tenant A' } });
  accountA = resA.json();

  const resB = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { name: 'Tenant B' } });
  accountB = resB.json();
});


describe('Plans & Users CRUD + Isolation', () => {
  it('creates a custom user plan for Account A', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/plans',
      headers: { 'x-api-key': accountA.apiKey },
      payload: { name: 'A-Custom', scope: 'user', monthlyAllowance: 500, maxPerRequest: 10 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('A-Custom');
  });

  it('does not allow Account B to see Account A custom plans', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/plans',
      headers: { 'x-api-key': accountB.apiKey },
    });
    const plans = res.json();
    const hasA_Custom = plans.some((p: any) => p.name === 'A-Custom');
    expect(hasA_Custom).toBe(false);
  });

  it('creates users under Account A', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { 'x-api-key': accountA.apiKey },
      payload: { externalId: 'user-1' }, 
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().externalId).toBe('user-1');
  });

  it('Account B cannot see Account A users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { 'x-api-key': accountB.apiKey },
    });
    expect(res.json()).toHaveLength(0);
  });

  it('Account B cannot assign Account A custom plan to its own user', async () => {
    const plansA = (await app.inject({ method: 'GET', url: '/v1/plans', headers: { 'x-api-key': accountA.apiKey } })).json();
    const planAId = plansA.find((p: any) => p.name === 'A-Custom').id;

    await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { 'x-api-key': accountB.apiKey },
      payload: { externalId: 'user-b1' },
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/users/user-b1/plan',
      headers: { 'x-api-key': accountB.apiKey },
      payload: { planId: planAId },
    });
    
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_plan');
  });
});
