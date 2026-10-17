import { Queue } from 'bullmq';
import { redisConfig } from '../redis/index.js';

export const EXPIRY_QUEUE_NAME = 'reservation-expiry-queue';

export interface ExpiryJobData {
  reservationId: string;
  eventId: string;
  ticketIds: string[];
}

export const expiryQueue = new Queue<ExpiryJobData>(EXPIRY_QUEUE_NAME, {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function scheduleReservationExpiry(data: ExpiryJobData, ttlSeconds: number): Promise<void> {
  const delayMs = ttlSeconds * 1000;
  await expiryQueue.add(
    'expire-reservation',
    data,
    {
      delay: delayMs,
      jobId: `expiry-${data.reservationId}`,
    }
  );
}

export async function cancelReservationExpiryJob(reservationId: string): Promise<void> {
  try {
    const job = await expiryQueue.getJob(`expiry-${reservationId}`);
    if (job) {
      await job.remove();
    }
  } catch (err) {
    console.warn(`Failed to remove expiry job for reservation ${reservationId}:`, err);
  }
}
