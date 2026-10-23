export interface Limits {
  monthly: number | null;
  perRequest: number | null;
}

export interface EvalContext {
  units: number;
  account: { limits: Limits; consumed: number };
  user: { limits: Limits; consumed: number };
}

export type EvalResult = 
  | { accepted: true; violations: [] }
  | { accepted: false; reason: { level: 'account' | 'user'; rule: 'max_per_request' | 'monthly_allowance'; limit?: number | null }; violations: any[] };

export function evaluate(ctx: EvalContext): EvalResult {
  const { units, account, user } = ctx;
  const violations: Array<{ level: 'account' | 'user'; rule: 'max_per_request' | 'monthly_allowance'; limit: number | null }> = [];
  const accPerRequest = account.limits.perRequest;
  const usrPerRequest = user.limits.perRequest;
  const accMonthly = account.limits.monthly;
  const usrMonthly = user.limits.monthly;

  if (accPerRequest !== null && units > accPerRequest) {
    violations.push({ level: 'account', rule: 'max_per_request', limit: accPerRequest });
  }
  if (usrPerRequest !== null && units > usrPerRequest) {
    violations.push({ level: 'user', rule: 'max_per_request', limit: usrPerRequest });
  }

  if (accMonthly !== null && (account.consumed + units) > accMonthly) {
    violations.push({ level: 'account', rule: 'monthly_allowance', limit: accMonthly });
  }
  if (usrMonthly !== null && (user.consumed + units) > usrMonthly) {
    violations.push({ level: 'user', rule: 'monthly_allowance', limit: usrMonthly });
  }

  if (violations.length > 0) {
    return { accepted: false, reason: violations[0], violations };
  }

  return { accepted: true, violations: [] };
}
