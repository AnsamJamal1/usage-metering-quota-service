import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { requireAuth } from '../auth';
import { AppError } from '../errors';

function getPeriod(monthStr?: string): string {
  const target = monthStr ?? new Date().toISOString().slice(0, 7); 
  if (!/^\d{4}-\d{2}$/.test(target)) {
    throw new AppError(400, 'invalid_month', 'Month must be in YYYY-MM format');
  }
  return `${target}-01`;
}

export async function usageRoutes(app: FastifyInstance) {
  
  app.get('/usage', { preHandler: requireAuth }, async (req) => {
    const query = z.object({ month: z.string().optional() }).parse(req.query);
    const period = getPeriod(query.month);

    const accRes = await pool.query(
      `SELECT a.id, a.name, p.monthly_allowance, p.max_per_request
       FROM accounts a JOIN plans p ON a.plan_id = p.id WHERE a.id = $1`,
      [req.accountId]
    );
    const account = accRes.rows[0];

    const accUsageRes = await pool.query(
      `SELECT consumed FROM account_usage WHERE account_id = $1 AND period = $2`,
      [req.accountId, period]
    );
    const accConsumed = accUsageRes.rows.length ? Number(accUsageRes.rows[0].consumed) : 0;

    const usersRes = await pool.query(
      `SELECT u.id, u.external_id, p.name as plan_name, p.monthly_allowance, p.max_per_request,
              COALESCE(us.consumed, 0) as consumed
       FROM users u
       JOIN plans p ON u.plan_id = p.id
       LEFT JOIN user_usage us ON us.user_id = u.id AND us.period = $2
       WHERE u.account_id = $1`,
      [req.accountId, period]
    );

    const users = usersRes.rows.map(r => {
      const limit = r.monthly_allowance !== null ? Number(r.monthly_allowance) : null;
      const consumed = Number(r.consumed);
      return {
        id: r.id,
        externalId: r.external_id,
        plan: r.plan_name,
        monthlyAllowance: limit,
        consumed,
        remaining: limit === null ? null : Math.max(0, limit - consumed),
      };
    });

    return {
      period: period.slice(0, 7),
      account: {
        id: account.id,
        name: account.name,
        monthlyAllowance: account.monthly_allowance !== null ? Number(account.monthly_allowance) : null,
        consumed: accConsumed,
        remaining: account.monthly_allowance === null ? null : Math.max(0, Number(account.monthly_allowance) - accConsumed),
      },
      users,
    };
  });

  app.get('/usage/users/:externalId', { preHandler: requireAuth }, async (req) => {
    const { externalId } = req.params as { externalId: string };
    const query = z.object({ month: z.string().optional() }).parse(req.query);
    const period = getPeriod(query.month);

    const res = await pool.query(
      `SELECT u.id, u.external_id, p.name as plan_name, p.monthly_allowance, p.max_per_request,
              COALESCE(us.consumed, 0) as consumed
       FROM users u
       JOIN plans p ON u.plan_id = p.id
       LEFT JOIN user_usage us ON us.user_id = u.id AND us.period = $2
       WHERE u.account_id = $1 AND u.external_id = $3`,
      [req.accountId, period, externalId]
    );

    if (res.rows.length === 0) throw new AppError(404, 'user_not_found', 'User not found');

    const r = res.rows[0];
    const limit = r.monthly_allowance !== null ? Number(r.monthly_allowance) : null;
    const consumed = Number(r.consumed);

    return {
      period: period.slice(0, 7),
      id: r.id,
      externalId: r.external_id,
      plan: r.plan_name,
      monthlyAllowance: limit,
      consumed,
      remaining: limit === null ? null : Math.max(0, limit - consumed),
    };
  });

  app.get('/requests', { preHandler: requireAuth }, async (req) => {
    const query = z.object({
      limit: z.coerce.number().min(1).max(100).default(20),
      offset: z.coerce.number().min(0).default(0),
      month: z.string().optional(),
      userId: z.string().optional(),
      status: z.enum(['accepted', 'rejected']).optional(),
    }).parse(req.query);

    const period = query.month ? getPeriod(query.month) : undefined;

    let sql = `SELECT id, request_id, user_id, units, status, rejected_level, rejected_rule, created_at 
               FROM requests WHERE account_id = $1`;
    const values: any[] = [req.accountId];
    let idx = 2;

    if (period) { sql += ` AND period = $${idx++}`; values.push(period); }
    if (query.status) { sql += ` AND status = $${idx++}`; values.push(query.status); }
    
    if (query.userId) {
      sql += ` AND user_id = (SELECT id FROM users WHERE account_id = $1 AND external_id = $${idx++})`;
      values.push(query.userId);
    }

    const countSql = `SELECT COUNT(*)::int as total FROM (${sql}) AS sub`;
    const countRes = await pool.query(countSql, values);
    const total = countRes.rows[0].total;

    sql += ` ORDER BY created_at DESC, id DESC LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(query.limit, query.offset);

    const { rows } = await pool.query(sql, values);

    return {
      total,
      limit: query.limit,
      offset: query.offset,
      data: rows.map(r => ({
        id: r.id,
        requestId: r.request_id,
        userId: r.user_id,
        units: Number(r.units),
        status: r.status,
        reason: r.status === 'rejected' ? { level: r.rejected_level, rule: r.rejected_rule } : null,
        createdAt: r.created_at,
      }))
    };
  });
}
