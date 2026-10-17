import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import { withTransaction, query } from '../db/index.js';
import { redis } from '../redis/index.js';
import { cancelReservationExpiryJob } from '../queues/queue.js';
import {
  CheckoutInput,
  CheckoutResult,
  ReservationRecord,
  EventRecord,
} from '../types/index.js';

export class CheckoutService {
  /**
   * Idempotent Checkout & Payment Settlement Engine
   * Prevents double-spending, duplicate charges, and duplicate ticket allocations.
   */
  async processCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const { reservationId, userId, idempotencyKey } = input;

    if (!idempotencyKey || idempotencyKey.trim() === '') {
      const err = new Error('Missing required Idempotency-Key header');
      (err as any).statusCode = 400;
      throw err;
    }

    const redisIdempotencyKey = `idempotency:${idempotencyKey}`;

    // 1. Check Redis for existing Idempotency state
    const cachedEntry = await redis.get(redisIdempotencyKey);
    if (cachedEntry) {
      if (cachedEntry === 'PENDING') {
        const err = new Error('Concurrent request with this Idempotency-Key is currently in-flight. Please wait.');
        (err as any).statusCode = 409;
        (err as any).code = 'CONCURRENT_REQUEST';
        throw err;
      }

      // Cached response exists: Return cached order payload immediately
      try {
        const parsed = JSON.parse(cachedEntry) as CheckoutResult;
        return {
          ...parsed,
          cachedResponse: true,
        };
      } catch (parseErr) {
        console.error('Failed to parse cached idempotency payload:', parseErr);
      }
    }

    // 2. Acquire In-Flight Distributed Lock for this Idempotency Key (NX with 60s safety TTL)
    const lockAcquired = await redis.set(redisIdempotencyKey, 'PENDING', 'EX', 60, 'NX');
    if (!lockAcquired) {
      const err = new Error('Another request with this Idempotency-Key is actively executing.');
      (err as any).statusCode = 409;
      (err as any).code = 'CONCURRENT_REQUEST';
      throw err;
    }

    try {
      // 3. PostgreSQL Transaction: Verify reservation, confirm, update tickets, create order
      const orderResult = await withTransaction(async (client) => {
        // A. Lock reservation row to prevent race conditions during checkout
        const reservationRes = await client.query<ReservationRecord>(
          `SELECT id, user_id, event_id, ticket_ids, status, expires_at 
           FROM reservations 
           WHERE id = $1 
           FOR UPDATE`,
          [reservationId]
        );

        if (reservationRes.rows.length === 0) {
          const err = new Error(`Reservation ${reservationId} not found`);
          (err as any).statusCode = 404;
          throw err;
        }

        const reservation = reservationRes.rows[0];

        // B. Ownership check
        if (reservation.user_id !== userId) {
          const err = new Error('Unauthorized: User does not own this reservation');
          (err as any).statusCode = 403;
          throw err;
        }

        // C. Check status & expiry
        if (reservation.status === 'CONFIRMED') {
          // If already confirmed in DB, retrieve existing order
          const existingOrder = await client.query(
            'SELECT id, total_amount, status FROM orders WHERE reservation_id = $1',
            [reservationId]
          );
          if (existingOrder.rows.length > 0) {
            return {
              orderId: existingOrder.rows[0].id,
              reservationId,
              userId,
              totalAmount: parseFloat(existingOrder.rows[0].total_amount),
              status: existingOrder.rows[0].status,
              idempotencyKey,
            } as CheckoutResult;
          }
        }

        if (reservation.status === 'EXPIRED') {
          const err = new Error('Reservation has already expired and tickets were returned to stock');
          (err as any).statusCode = 410; // Gone
          (err as any).code = 'RESERVATION_EXPIRED';
          throw err;
        }

        const now = new Date();
        if (new Date(reservation.expires_at).getTime() <= now.getTime()) {
          const err = new Error('Reservation has expired. Checkout window elapsed');
          (err as any).statusCode = 410;
          (err as any).code = 'RESERVATION_EXPIRED';
          throw err;
        }

        // D. Calculate total amount
        const eventRes = await client.query<EventRecord>(
          'SELECT ticket_price FROM events WHERE id = $1',
          [reservation.event_id]
        );

        const ticketPrice = parseFloat(eventRes.rows[0]?.ticket_price?.toString() || '50.00');
        const totalAmount = ticketPrice * reservation.ticket_ids.length;

        // E. Transition Reservation to CONFIRMED
        await client.query(
          `UPDATE reservations 
           SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [reservationId]
        );

        // F. Mark tickets as SOLD
        await client.query(
          `UPDATE tickets 
           SET status = 'SOLD', updated_at = CURRENT_TIMESTAMP 
           WHERE id = ANY($1::uuid[])`,
          [reservation.ticket_ids]
        );

        // G. Create Order with unique Idempotency Key
        const orderId = uuidv4();
        await client.query(
          `INSERT INTO orders (id, reservation_id, user_id, total_amount, idempotency_key, status)
           VALUES ($1, $2, $3, $4, $5, 'PAID')`,
          [orderId, reservationId, userId, totalAmount, idempotencyKey]
        );

        return {
          orderId,
          reservationId,
          userId,
          totalAmount,
          status: 'PAID',
          idempotencyKey,
        } as CheckoutResult;
      });

      // 4. Update Redis State Post-Commit
      // Mark reservation CONFIRMED in Redis
      await redis.hset(`reservation:${reservationId}`, 'status', 'CONFIRMED');

      // Cancel BullMQ expiry delayed job
      await cancelReservationExpiryJob(reservationId);

      // Cache Idempotency payload with 24-hour TTL
      await redis.set(
        redisIdempotencyKey,
        JSON.stringify(orderResult),
        'EX',
        env.IDEMPOTENCY_TTL_SECONDS
      );

      return orderResult;
    } catch (err) {
      // If payment / settlement failed before committing, remove the in-flight lock
      // so the client can safely retry with a new or corrected request
      await redis.del(redisIdempotencyKey);
      throw err;
    }
  }

  async getOrder(orderId: string) {
    const res = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (res.rows.length === 0) {
      const err = new Error(`Order ${orderId} not found`);
      (err as any).statusCode = 404;
      throw err;
    }
    return res.rows[0];
  }
}

export const checkoutService = new CheckoutService();
