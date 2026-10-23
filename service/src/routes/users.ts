import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { requireAuth } from '../auth';
import { AppError } from '../errors';
import { DEFAULT_USER_PLAN_ID } from '../seed';

const createUserSchema = z.object({
  externalId: z.string().trim().min(1).max(100),
  planId: z.string().uuid().optional(),
});

const updatePlanSchema = z.object({
  planId: z.string().uuid(),
});

export async function userRoutes(app: FastifyInstance) {
  async function validateUserPlan(accountId: string, planId: string) {
    const { rows } = await pool.query(
      `SELECT id FROM plans 
       WHERE id = $1 AND scope = 'user' AND (is_predefined = true OR account_id = $2)`,
      [planId, accountId]
    );
    if (rows.length === 0) {
      throw new AppError(400, 'invalid_plan', 'Plan does not exist, is not a user plan, or belongs to another account');
    }
  }

  app.post('/users', { preHandler: requireAuth }, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const planId = body.planId ?? DEFAULT_USER_PLAN_ID;

    await validateUserPlan(req.accountId, planId);

    try {
      const { rows } = await pool.query(
        `INSERT INTO users (account_id, external_id, plan_id)
         VALUES ($1, $2, $3)
         RETURNING id, external_id, plan_id, created_at`,
        [req.accountId, body.externalId, planId]
      );
      return reply.code(201).send({
        id: rows[0].id,
        externalId: rows[0].external_id,
        planId: rows[0].plan_id,
        createdAt: rows[0].created_at,
      });
    } catch (err: any) {
      if (err.code === '23505') {
        throw new AppError(409, 'user_exists', 'A user with this externalId already exists in your account');
      }
      throw err;
    }
  });

  app.get('/users', { preHandler: requireAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.external_id, u.plan_id, p.name AS plan_name, p.monthly_allowance, p.max_per_request
       FROM users u JOIN plans p ON p.id = u.plan_id
       WHERE u.account_id = $1 ORDER BY u.created_at ASC`,
      [req.accountId]
    );
    return rows.map(r => ({
      id: r.id,
      externalId: r.external_id,
      plan: {
        id: r.plan_id,
        name: r.plan_name,
        monthlyAllowance: r.monthly_allowance,
        maxPerRequest: r.max_per_request,
      }
    }));
  });

  app.get('/users/:externalId', { preHandler: requireAuth }, async (req) => {
    const { externalId } = req.params as { externalId: string };
    const { rows } = await pool.query(
      `SELECT u.id, u.external_id, u.plan_id, p.name AS plan_name, p.monthly_allowance, p.max_per_request
       FROM users u JOIN plans p ON p.id = u.plan_id
       WHERE u.account_id = $1 AND u.external_id = $2`,
      [req.accountId, externalId]
    );
    if (rows.length === 0) throw new AppError(404, 'user_not_found', 'User not found');
    
    const r = rows[0];
    return {
      id: r.id,
      externalId: r.external_id,
      plan: {
        id: r.plan_id,
        name: r.plan_name,
        monthlyAllowance: r.monthly_allowance,
        maxPerRequest: r.max_per_request,
      }
    };
  });

  app.put('/users/:externalId/plan', { preHandler: requireAuth }, async (req) => {
    const { externalId } = req.params as { externalId: string };
    const { planId } = updatePlanSchema.parse(req.body);

    await validateUserPlan(req.accountId, planId);

    const { rows } = await pool.query(
      `UPDATE users SET plan_id = $1
       WHERE account_id = $2 AND external_id = $3
       RETURNING id, external_id, plan_id`,
      [planId, req.accountId, externalId]
    );
    if (rows.length === 0) throw new AppError(404, 'user_not_found', 'User not found');

    return { id: rows[0].id, externalId: rows[0].external_id, planId: rows[0].plan_id };
  });
}
