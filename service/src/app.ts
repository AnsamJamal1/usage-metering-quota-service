import Fastify from 'fastify';
import { pool } from './db';

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  return app;
}
