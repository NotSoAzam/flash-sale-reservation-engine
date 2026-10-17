import { FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { reservationService } from '../services/reservation.service.js';
import { ReservationStrategy } from '../types/index.js';

export async function reserveTicketHandler(
  req: FastifyRequest<{
    Params: { id: string };
    Body: {
      userId?: string;
      quantity?: number;
      strategy?: ReservationStrategy;
    };
    Querystring: {
      strategy?: ReservationStrategy;
    };
  }>,
  reply: FastifyReply
) {
  const { id: eventId } = req.params;
  const userId = req.body?.userId || uuidv4();
  const quantity = req.body?.quantity ?? 1;
  const strategy = req.body?.strategy || req.query?.strategy || 'redis_lua';

  try {
    const result = await reservationService.reserveTickets({
      eventId,
      userId,
      quantity,
      strategy,
    });

    return reply.status(201).send({
      statusCode: 201,
      message: 'Tickets successfully reserved. Complete payment within 5 minutes.',
      data: result,
    });
  } catch (err: any) {
    const statusCode = err.statusCode || (err.code === 'SOLD_OUT' ? 409 : 500);
    return reply.status(statusCode).send({
      statusCode,
      error: statusCode === 409 ? 'Conflict / Sold Out' : 'Reservation Error',
      message: err.message,
      code: err.code || 'RESERVATION_FAILED',
    });
  }
}

export async function getReservationHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  try {
    const reservation = await reservationService.getReservation(id);
    return reply.status(200).send({ statusCode: 200, data: reservation });
  } catch (err: any) {
    const statusCode = err.statusCode || 404;
    return reply.status(statusCode).send({
      statusCode,
      error: 'Not Found',
      message: err.message,
    });
  }
}
