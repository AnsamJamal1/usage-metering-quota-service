import { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { pool } from '../db';
import { config } from '../config';
import { generateApiKey, hashApiKey } from '../apiKey';
import { requireAuth } from '../auth';
import { AppError } from '../errors';
import { DEFAULT_ACCOUNT_PLAN_ID } from '../seed';

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  planId: z.string().uuid().optional(),
});

function checkAdminKey(header: unknown): void {
  if (!config.adminKey) return; 
  const a = Buffer.from(typeof header === 'string' ? header : '');
  const b = Buffer.from(config.adminKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(401, 'invalid_admin_key', 'A valid X-Admin-Key header is required');
  }
}

export async function accountRoutes(app: FastifyInstance) {
  app.post('/accounts', async (req, reply) => {
    checkAdminKey(req.headers['x-admin-key']);
    const body = createAccountSchema.parse(req.body);
    const planId = body.planId ?? DEFAULT_ACCOUNT_PLAN_ID;

    const plan = await pool.query(
      `SELECT id FROM plans WHERE id = $1 AND scope = 'account' AND is_predefined`,
      [planId],
    );
    if (plan.rows.length === 0) {
      throw new AppError(400, 'invalid_plan', 'planId must be a predefined account plan');
    }

    const apiKey = generateApiKey();
    const { rows } = await pool.query(
      `INSERT INTO accounts (name, api_key_hash, plan_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, plan_id, created_at`,
      [body.name, hashApiKey(apiKey), planId],
    );
    const a = rows[0];

    return reply.code(201).send({
      account: { id: a.id, name: a.name, planId: a.plan_id, createdAt: a.created_at },
      apiKey, 
    });
  });

  app.get('/account', { preHandler: requireAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.created_at,
              p.id AS plan_id, p.name AS plan_name, p.scope,
              p.monthly_allowance, p.max_per_request, p.is_predefined
       FROM accounts a JOIN plans p ON p.id = a.plan_id
       WHERE a.id = $1`,
      [req.accountId],
    );
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      plan: {
        id: r.plan_id,
        name: r.plan_name,
        scope: r.scope,
        monthlyAllowance: r.monthly_allowance,
        maxPerRequest: r.max_per_request,
        isPredefined: r.is_predefined,
      },
    };
  });
}
