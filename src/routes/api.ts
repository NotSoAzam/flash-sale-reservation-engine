import { FastifyInstance } from 'fastify';
import {
  createEventHandler,
  getEventHandler,
  listEventsHandler,
  syncEventHandler,
} from '../controllers/event.controller.js';
import {
  reserveTicketHandler,
  getReservationHandler,
} from '../controllers/reservation.controller.js';
import {
  checkoutHandler,
  getOrderHandler,
} from '../controllers/checkout.controller.js';
import { checkDbHealth } from '../db/index.js';
import { checkRedisHealth } from '../redis/index.js';

export async function apiRoutes(server: FastifyInstance) {
  // Liveness & Readiness Probes
  server.get('/health', async (_req, reply) => {
    const dbHealthy = await checkDbHealth();
    const redisHealthy = await checkRedisHealth();

    const isHealthy = dbHealthy && redisHealthy;
    return reply.status(isHealthy ? 200 : 503).send({
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'UP' : 'DOWN',
        redis: redisHealthy ? 'UP' : 'DOWN',
      },
    });
  });

  // Events API
  server.post('/api/v1/events', createEventHandler);
  server.get('/api/v1/events', listEventsHandler);
  server.get('/api/v1/events/:id', getEventHandler);
  server.post('/api/v1/events/:id/sync', syncEventHandler);

  // High-Concurrency Reservation API
  server.post('/api/v1/events/:id/reserve', reserveTicketHandler);
  server.get('/api/v1/reservations/:id', getReservationHandler);

  // Idempotent Checkout & Settlement API
  server.post('/api/v1/orders/checkout', checkoutHandler);
  server.get('/api/v1/orders/:id', getOrderHandler);
}
