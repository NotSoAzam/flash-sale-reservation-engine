import { FastifyRequest, FastifyReply } from 'fastify';
import { eventService } from '../services/event.service.js';

export async function createEventHandler(
  req: FastifyRequest<{
    Body: {
      title: string;
      totalTickets: number;
      ticketPrice?: number;
      saleStartTime?: string;
      saleEndTime?: string;
    };
  }>,
  reply: FastifyReply
) {
  const { title, totalTickets, ticketPrice, saleStartTime, saleEndTime } = req.body;

  if (!title || !totalTickets || totalTickets <= 0) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Title and a positive totalTickets count are required.',
    });
  }

  const result = await eventService.createEvent({
    title,
    totalTickets,
    ticketPrice,
    saleStartTime: saleStartTime ? new Date(saleStartTime) : undefined,
    saleEndTime: saleEndTime ? new Date(saleEndTime) : undefined,
  });

  return reply.status(201).send({
    statusCode: 201,
    message: 'Event created and tickets initialized in PostgreSQL and Redis',
    data: result,
  });
}

export async function getEventHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  try {
    const event = await eventService.getEvent(id);
    return reply.status(200).send({ statusCode: 200, data: event });
  } catch (err: any) {
    return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: err.message });
  }
}

export async function listEventsHandler(req: FastifyRequest, reply: FastifyReply) {
  const events = await eventService.listEvents();
  return reply.status(200).send({ statusCode: 200, data: events });
}

export async function syncEventHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  const syncedCount = await eventService.syncEventToRedis(id);
  return reply.status(200).send({
    statusCode: 200,
    message: `Synced ${syncedCount} available tickets into Redis pool`,
    eventId: id,
    availableCount: syncedCount,
  });
}
