import { FastifyRequest } from 'fastify';
import { pool } from './db';
import { hashApiKey } from './apiKey';
import { AppError } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string;
  }
}

export async function requireAuth(req: FastifyRequest): Promise<void> {
  const key = req.headers['x-api-key'];

  if (typeof key !== 'string' || key.length === 0) {
    throw new AppError(401, 'missing_api_key', 'Provide your API key in the X-API-Key header');
  }

  const { rows } = await pool.query('SELECT id FROM accounts WHERE api_key_hash = $1', [
    hashApiKey(key),
  ]);
  if (rows.length === 0) {
    throw new AppError(401, 'invalid_api_key', 'The API key is not valid');
  }

  req.accountId = rows[0].id as string;
}
