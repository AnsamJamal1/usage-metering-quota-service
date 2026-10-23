import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { requireAuth } from '../auth';
import { AppError } from '../errors';

const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['account', 'user']),
  monthlyAllowance: z.number().int().min(0).nullable(), 
  maxPerRequest: z.number().int().min(1).nullable(),
});

const updatePlanSchema = createPlanSchema.partial().refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided',
});

export async function planRoutes(app: FastifyInstance) {
  app.get('/plans', { preHandler: requireAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, account_id, scope, name, monthly_allowance, max_per_request, is_predefined
       FROM plans
       WHERE is_predefined = true OR account_id = $1
       ORDER BY is_predefined DESC, name ASC`,
      [req.accountId]
    );
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      monthlyAllowance: r.monthly_allowance,
      maxPerRequest: r.max_per_request,
      isPredefined: r.is_predefined,
      accountId: r.account_id,
    }));
  });

  app.post('/plans', { preHandler: requireAuth }, async (req, reply) => {
    const body = createPlanSchema.parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO plans (account_id, scope, name, monthly_allowance, max_per_request, is_predefined)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id, name, scope, monthly_allowance, max_per_request, is_predefined`,
      [req.accountId, body.scope, body.name, body.monthlyAllowance, body.maxPerRequest]
    );

    return reply.code(201).send(rows[0]);
  });

  app.patch('/plans/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = updatePlanSchema.parse(req.body);

    const check = await pool.query(
      `SELECT is_predefined FROM plans WHERE id = $1 AND account_id = $2`,
      [id, req.accountId]
    );
    if (check.rows.length === 0) throw new AppError(404, 'plan_not_found', 'Plan not found');
    if (check.rows[0].is_predefined) throw new AppError(403, 'forbidden', 'Predefined plans cannot be modified');

    const updates = [];
    const values: any[] = [];
    let idx = 1;

    if (body.name !== undefined) { updates.push(`name = $${idx++}`); values.push(body.name); }
    if (body.monthlyAllowance !== undefined) { updates.push(`monthly_allowance = $${idx++}`); values.push(body.monthlyAllowance); }
    if (body.maxPerRequest !== undefined) { updates.push(`max_per_request = $${idx++}`); values.push(body.maxPerRequest); }
    
    updates.push(`updated_at = now()`);
    values.push(id, req.accountId);

    const { rows } = await pool.query(
      `UPDATE plans SET ${updates.join(', ')}
       WHERE id = $${idx++} AND account_id = $${idx++}
       RETURNING id, name, scope, monthly_allowance, max_per_request`,
      values
    );

    return rows[0];
  });
}
