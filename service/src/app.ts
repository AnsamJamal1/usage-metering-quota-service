import Fastify from 'fastify';
import { ZodError } from 'zod';
import { pool } from './db';
import { AppError } from './errors';
import { accountRoutes } from './routes/accounts';
import { planRoutes } from './routes/plans';
import { userRoutes } from './routes/users';
import { consumeRoutes } from './routes/consume';

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'Invalid request', details: err.issues },
      });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({
        error: { code: 'bad_request', message: e.message },
      });
    }
    req.log.error(err);
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.register(accountRoutes, { prefix: '/v1' });
  app.register(planRoutes, { prefix: '/v1' });
  app.register(userRoutes, { prefix: '/v1' });
  app.register(consumeRoutes, { prefix: '/v1' });

  return app;
}
