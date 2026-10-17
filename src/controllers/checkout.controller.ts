import { FastifyRequest, FastifyReply } from 'fastify';
import { checkoutService } from '../services/checkout.service.js';

export async function checkoutHandler(
  req: FastifyRequest<{
    Headers: {
      'idempotency-key'?: string;
      'Idempotency-Key'?: string;
    };
    Body: {
      reservationId: string;
      userId: string;
    };
  }>,
  reply: FastifyReply
) {
  const idempotencyKey =
    req.headers['idempotency-key'] ||
    req.headers['Idempotency-Key'] ||
    (req.headers as any)['Idempotency-key'];

  if (!idempotencyKey) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Missing mandatory Idempotency-Key header.',
    });
  }

  const { reservationId, userId } = req.body || {};
  if (!reservationId || !userId) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'reservationId and userId are required in the request body.',
    });
  }

  try {
    const result = await checkoutService.processCheckout({
      reservationId,
      userId,
      idempotencyKey: Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey,
    });

    if (result.cachedResponse) {
      reply.header('X-Cache-Lookup', 'HIT');
      reply.header('X-Idempotency-Key', idempotencyKey);
      return reply.status(200).send({
        statusCode: 200,
        message: 'Order already settled (idempotent cached response).',
        data: result,
      });
    }

    reply.header('X-Cache-Lookup', 'MISS');
    reply.header('X-Idempotency-Key', idempotencyKey);
    return reply.status(201).send({
      statusCode: 201,
      message: 'Order placed successfully and tickets confirmed.',
      data: result,
    });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    return reply.status(statusCode).send({
      statusCode,
      error: statusCode === 409 ? 'Conflict' : statusCode === 410 ? 'Gone' : 'Checkout Failed',
      message: err.message,
      code: err.code || 'CHECKOUT_ERROR',
    });
  }
}

export async function getOrderHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  try {
    const order = await checkoutService.getOrder(id);
    return reply.status(200).send({ statusCode: 200, data: order });
  } catch (err: any) {
    const statusCode = err.statusCode || 404;
    return reply.status(statusCode).send({
      statusCode,
      error: 'Not Found',
      message: err.message,
    });
  }
}
