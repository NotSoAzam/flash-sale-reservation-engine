import { Worker, Job } from 'bullmq';
import { redisConfig, redis } from '../redis/index.js';
import { EXPIRY_QUEUE_NAME, ExpiryJobData } from '../queues/queue.js';
import { withTransaction, query } from '../db/index.js';
import { executeAtomicRelease } from '../redis/scripts.js';

export function createExpiryWorker(): Worker<ExpiryJobData> {
  const worker = new Worker<ExpiryJobData>(
    EXPIRY_QUEUE_NAME,
    async (job: Job<ExpiryJobData>) => {
      const { reservationId, eventId, ticketIds } = job.data;
      console.log(`⏱️ Processing expiry check for reservation: ${reservationId} (Event: ${eventId})`);

      // 1. Check reservation status in PostgreSQL
      const reservationRes = await query(
        'SELECT id, status, ticket_ids, event_id FROM reservations WHERE id = $1',
        [reservationId]
      );

      if (reservationRes.rows.length === 0) {
        console.warn(`Reservation ${reservationId} not found in database.`);
        return { status: 'NOT_FOUND' };
      }

      const reservation = reservationRes.rows[0];

      // If already CONFIRMED (paid) or already EXPIRED, no rollback needed
      if (reservation.status !== 'PENDING') {
        console.log(`Reservation ${reservationId} is already ${reservation.status}. Skipping rollback.`);
        return { status: reservation.status, skipped: true };
      }

      // 2. Perform transactional rollback in PostgreSQL
      await withTransaction(async (client) => {
        // Re-check with row lock inside transaction
        const lockRes = await client.query(
          'SELECT status FROM reservations WHERE id = $1 FOR UPDATE',
          [reservationId]
        );

        if (lockRes.rows[0]?.status !== 'PENDING') {
          return;
        }

        // Mark reservation EXPIRED
        await client.query(
          `UPDATE reservations 
           SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [reservationId]
        );

        // Mark tickets back to AVAILABLE
        await client.query(
          `UPDATE tickets 
           SET status = 'AVAILABLE', updated_at = CURRENT_TIMESTAMP 
           WHERE id = ANY($1::uuid[])`,
          [ticketIds]
        );

        // Increment available tickets in events
        await client.query(
          `UPDATE events 
           SET available_tickets = available_tickets + $1, updated_at = CURRENT_TIMESTAMP 
           WHERE id = $2`,
          [ticketIds.length, eventId]
        );
      });

      // 3. Rollback in Redis using Lua script
      try {
        const releaseResult = await executeAtomicRelease({
          eventId,
          reservationId,
        });

        if (releaseResult.success) {
          console.log(`✅ Returned ${releaseResult.ticketIds.length} tickets to Redis pool for event ${eventId}.`);
        } else {
          // If the reservation key in Redis already expired or was not found,
          // restore tickets back into the Redis set directly
          console.log(`Fallback direct Redis ticket restoration for event ${eventId}.`);
          if (ticketIds.length > 0) {
            await redis.sadd(`event:${eventId}:tickets`, ...ticketIds);
          }
        }
      } catch (redisErr) {
        console.error(`Failed to release tickets in Redis for reservation ${reservationId}:`, redisErr);
      }

      console.log(`🧹 Reservation ${reservationId} successfully expired and inventory rolled back.`);
      return { status: 'EXPIRED', releasedTickets: ticketIds.length };
    },
    {
      connection: redisConfig,
      concurrency: 10,
    }
  );

  worker.on('completed', (job) => {
    console.log(`Worker job ${job.id} completed.`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Worker job ${job?.id} failed with error:`, err);
  });

  return worker;
}

// Standalone execution support
if (process.argv[1]?.endsWith('expiry.worker.ts') || process.argv[1]?.endsWith('expiry.worker.js')) {
  console.log('👷 Starting standalone Reservation Expiry Worker...');
  const worker = createExpiryWorker();

  const shutdown = async () => {
    console.log('Shutting down expiry worker...');
    await worker.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
