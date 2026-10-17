import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { apiRoutes } from './routes/api.js';

export function buildApp(): FastifyInstance {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    disableRequestLogging: process.env.NODE_ENV === 'test',
  });

  // Enable CORS
  app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'idempotency-key'],
  });

  // Register API Routes
  app.register(apiRoutes);

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal Server Error';

    // Handle PostgreSQL unique constraint violations (e.g. 23505)
    if ((error as any).code === '23505') {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Duplicate key constraint violation.',
        detail: (error as any).detail,
      });
    }

    return reply.status(statusCode).send({
      statusCode,
      error: error.name || 'Error',
      message,
    });
  });

  return app;
}
