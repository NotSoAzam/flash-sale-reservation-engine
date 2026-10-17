import { Redis, RedisOptions } from 'ioredis';
import { env } from '../config/env.js';

export const redisConfig: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (process.env.NODE_ENV === 'test' && times > 1) {
      return null; // Stop retrying in test mode
    }
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
};

export const redis = new Redis(redisConfig);

redis.on('connect', () => {
  console.log('🔌 Connected to Redis successfully.');
});

redis.on('error', (err) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error('❌ Redis Connection Error:', err);
  }
});

export async function checkRedisHealth(): Promise<boolean> {
  try {
    if (redis.status === 'wait') {
      await redis.connect().catch(() => {});
    }
    const ping = await redis.ping();
    return ping === 'PONG';
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('❌ Redis Health Check Failed:', error);
    }
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  try {
    if (redis.status !== 'end') {
      await redis.quit();
    }
  } catch {
    redis.disconnect();
  }
}
