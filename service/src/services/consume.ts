import { pool, tx } from '../db';
import { AppError } from '../errors';
import { evaluate } from '../rules/evaluate';

export async function consumeUnits(
  accountId: string, 
  externalId: string, 
  units: number, 
  requestId: string
) {
  const userRes = await pool.query(
    `SELECT id FROM users WHERE account_id = $1 AND external_id = $2`,
    [accountId, externalId]
  );
  if (userRes.rows.length === 0) {
    throw new AppError(404, 'user_not_found', 'User does not exist in this account');
  }
  const userId = userRes.rows[0].id;
  
  const period = new Date().toISOString().slice(0, 7) + '-01';

  return await tx(async (client) => {
    const accUsageRes = await client.query(
      `INSERT INTO account_usage (account_id, period, consumed) 
       VALUES ($1, $2, 0)
       ON CONFLICT (account_id, period) 
       DO UPDATE SET consumed = account_usage.consumed
       RETURNING consumed`,
      [accountId, period]
    );
    const accountConsumed = Number(accUsageRes.rows[0].consumed);

    const prevReq = await client.query(
      `SELECT units, status, rejected_level, rejected_rule, user_id, snapshot FROM requests WHERE account_id = $1 AND request_id = $2`,
      [accountId, requestId]
    );
     if (prevReq.rows.length > 0) {
      const prev = prevReq.rows[0];
      if (prev.user_id !== userId || Number(prev.units) !== units) {
        throw new AppError(409, 'idempotency_conflict', 'Request ID already used with different payload');
      }
      
      const snap = prev.snapshot;
      const accepted = prev.status === 'accepted';
      
      const accConsumedAfter = accepted ? snap.account.consumed + Number(prev.units) : snap.account.consumed;
      const usrConsumedAfter = accepted ? snap.user.consumed + Number(prev.units) : snap.user.consumed;
      
      const accRemaining = snap.account.limit === null ? null : Math.max(0, snap.account.limit - accConsumedAfter);
      const usrRemaining = snap.user.limit === null ? null : Math.max(0, snap.user.limit - usrConsumedAfter);

      return { 
        accepted: accepted, 
        reason: accepted ? null : { level: prev.rejected_level, rule: prev.rejected_rule },
        remaining: { account: accRemaining, user: usrRemaining },
        replayed: true 
      };
    }

    const userUsageRes = await client.query(
      `INSERT INTO user_usage (user_id, period, consumed) 
       VALUES ($1, $2, 0)
       ON CONFLICT (user_id, period) 
       DO UPDATE SET consumed = user_usage.consumed
       RETURNING consumed`,
      [userId, period]
    );
    const userConsumed = Number(userUsageRes.rows[0].consumed);

    const plansRes = await client.query(
      `SELECT 
         a.plan_id as acc_plan_id, p_acc.monthly_allowance as acc_monthly, p_acc.max_per_request as acc_max,
         u.plan_id as usr_plan_id, p_usr.monthly_allowance as usr_monthly, p_usr.max_per_request as usr_max
       FROM accounts a
       JOIN plans p_acc ON a.plan_id = p_acc.id
       JOIN users u ON u.id = $1
       JOIN plans p_usr ON u.plan_id = p_usr.id
       WHERE a.id = $2`,
      [userId, accountId]
    );
    const plans = plansRes.rows[0];

    const evalResult = evaluate({
      units,
      account: { 
        limits: { monthly: plans.acc_monthly, perRequest: plans.acc_max }, 
        consumed: accountConsumed 
      },
      user: { 
        limits: { monthly: plans.usr_monthly, perRequest: plans.usr_max }, 
        consumed: userConsumed 
      },
    });

    const snapshot = {
      account: { consumed: accountConsumed, limit: plans.acc_monthly, perRequest: plans.acc_max },
      user: { consumed: userConsumed, limit: plans.usr_monthly, perRequest: plans.usr_max },
    };

    if (evalResult.accepted) {
      await client.query(`UPDATE account_usage SET consumed = consumed + $1 WHERE account_id = $2 AND period = $3`, [units, accountId, period]);
      await client.query(`UPDATE user_usage SET consumed = consumed + $1 WHERE user_id = $2 AND period = $3`, [units, userId, period]);
    }

    await client.query(
      `INSERT INTO requests 
        (account_id, user_id, request_id, units, period, status, rejected_level, rejected_rule, account_plan_id, user_plan_id, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        accountId, userId, requestId, units, period, 
        evalResult.accepted ? 'accepted' : 'rejected',
        evalResult.accepted ? null : evalResult.reason.level,
        evalResult.accepted ? null : evalResult.reason.rule,
        plans.acc_plan_id, plans.usr_plan_id, snapshot
      ]
    );

    const accRemaining = plans.acc_monthly === null ? null : Math.max(0, plans.acc_monthly - accountConsumed - (evalResult.accepted ? units : 0));
    const usrRemaining = plans.usr_monthly === null ? null : Math.max(0, plans.usr_monthly - userConsumed - (evalResult.accepted ? units : 0));

    return {
      accepted: evalResult.accepted,
      reason: evalResult.accepted ? null : evalResult.reason,
      remaining: { account: accRemaining, user: usrRemaining },
      replayed: false
    };
  });
}
