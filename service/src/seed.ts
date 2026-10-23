import { pool } from './db';

export const PLAN_IDS = {
  starter: '00000000-0000-4000-8000-000000000001',
  pro: '00000000-0000-4000-8000-000000000002',
  basic: '00000000-0000-4000-8000-000000000003',
  premium: '00000000-0000-4000-8000-000000000004',
} as const;

export const DEFAULT_ACCOUNT_PLAN_ID = PLAN_IDS.starter;
export const DEFAULT_USER_PLAN_ID = PLAN_IDS.basic;

const PREDEFINED_PLANS = [
  { id: PLAN_IDS.starter, scope: 'account', name: 'Starter', monthly: 10_000, perRequest: 100 },
  { id: PLAN_IDS.pro, scope: 'account', name: 'Pro', monthly: 100_000, perRequest: 1_000 },
  { id: PLAN_IDS.basic, scope: 'user', name: 'Basic', monthly: 1_000, perRequest: 20 },
  { id: PLAN_IDS.premium, scope: 'user', name: 'Premium', monthly: 10_000, perRequest: 200 },
];

export async function seed(): Promise<void> {
  for (const p of PREDEFINED_PLANS) {
    await pool.query(
      `INSERT INTO plans (id, account_id, scope, name, monthly_allowance, max_per_request, is_predefined)
       VALUES ($1, NULL, $2, $3, $4, $5, true)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.scope, p.name, p.monthly, p.perRequest],
    );
  }
}
