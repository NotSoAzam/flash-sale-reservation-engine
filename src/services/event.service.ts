import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db/index.js';
import { redis } from '../redis/index.js';
import { EventRecord } from '../types/index.js';

export interface CreateEventInput {
  title: string;
  totalTickets: number;
  ticketPrice?: number;
  saleStartTime?: Date;
  saleEndTime?: Date;
}

export class EventService {
  async createEvent(input: CreateEventInput): Promise<{ event: EventRecord; ticketCount: number }> {
    const eventId = uuidv4();
    const price = input.ticketPrice ?? 50.0;
    const startTime = input.saleStartTime ?? new Date();
    const endTime = input.saleEndTime ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const ticketIds: string[] = [];
    for (let i = 1; i <= input.totalTickets; i++) {
      ticketIds.push(uuidv4());
    }

    await withTransaction(async (client) => {
      // 1. Insert Event
      await client.query(
        `INSERT INTO events (id, title, total_tickets, available_tickets, ticket_price, sale_start_time, sale_end_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId, input.title, input.totalTickets, input.totalTickets, price, startTime, endTime]
      );

      // 2. Batch Insert Tickets (Chunks of 500 for high performance)
      const chunkSize = 500;
      for (let i = 0; i < ticketIds.length; i += chunkSize) {
        const chunk = ticketIds.slice(i, i + chunkSize);
        const valuePlaceholders: string[] = [];
        const values: any[] = [];

        chunk.forEach((ticketId, idx) => {
          const seatNum = `SEAT-${i + idx + 1}`;
          const offset = idx * 3;
          valuePlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, 'AVAILABLE', 0)`);
          values.push(ticketId, eventId, seatNum);
        });

        await client.query(
          `INSERT INTO tickets (id, event_id, seat_number, status, version)
           VALUES ${valuePlaceholders.join(', ')}`,
          values
        );
      }
    });

    // 3. Populate Redis Available Tickets Set
    const redisKey = `event:${eventId}:tickets`;
    await redis.del(redisKey);
    // Redis SADD in chunks
    const redisChunkSize = 1000;
    for (let i = 0; i < ticketIds.length; i += redisChunkSize) {
      const chunk = ticketIds.slice(i, i + redisChunkSize);
      await redis.sadd(redisKey, ...chunk);
    }

    const eventRes = await query<EventRecord>('SELECT * FROM events WHERE id = $1', [eventId]);
    return {
      event: eventRes.rows[0],
      ticketCount: ticketIds.length,
    };
  }

  async getEvent(eventId: string): Promise<EventRecord & { redisAvailableTickets: number }> {
    const res = await query<EventRecord>('SELECT * FROM events WHERE id = $1', [eventId]);
    if (res.rows.length === 0) {
      throw new Error(`Event ${eventId} not found`);
    }

    const redisCount = await redis.scard(`event:${eventId}:tickets`);
    return {
      ...res.rows[0],
      redisAvailableTickets: redisCount,
    };
  }

  async syncEventToRedis(eventId: string): Promise<number> {
    const res = await query<{ id: string }>(
      `SELECT id FROM tickets WHERE event_id = $1 AND status = 'AVAILABLE'`,
      [eventId]
    );

    const redisKey = `event:${eventId}:tickets`;
    await redis.del(redisKey);

    if (res.rows.length > 0) {
      const ids = res.rows.map((r) => r.id);
      const chunkSize = 1000;
      for (let i = 0; i < ids.length; i += chunkSize) {
        await redis.sadd(redisKey, ...ids.slice(i, i + chunkSize));
      }
    }

    return res.rows.length;
  }

  async listEvents(): Promise<EventRecord[]> {
    const res = await query<EventRecord>('SELECT * FROM events ORDER BY created_at DESC LIMIT 50');
    return res.rows;
  }
}

export const eventService = new EventService();
