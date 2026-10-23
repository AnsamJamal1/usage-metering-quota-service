import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { consumeUnits } from '../services/consume';

const consumeSchema = z.object({
  userId: z.string().min(1), 
  units: z.number().int().positive(),
  requestId: z.string().min(1).max(255),
});

export async function consumeRoutes(app: FastifyInstance) {
  app.post('/consume', { preHandler: requireAuth }, async (req) => {
    const body = consumeSchema.parse(req.body);
    
    const result = await consumeUnits(
      req.accountId, 
      body.userId, 
      body.units, 
      body.requestId
    );

    return {
      requestId: body.requestId,
      units: body.units,
      ...result
    };
  });
}
