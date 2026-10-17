import { buildApp } from './app.js';
import { env } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { checkDbHealth, closeDbPool } from './db/index.js';
import { checkRedisHealth, closeRedis } from './redis/index.js';
import { initRedisScripts } from './redis/scripts.js';
import { createExpiryWorker } from './workers/expiry.worker.js';
import { expiryQueue } from './queues/queue.js';

async function bootstrap() {
  console.log('🚀 Initializing Flash Sale Reservation API Engine...');

  // 1. Verify PostgreSQL & run schema migrations
  const isDbUp = await checkDbHealth();
  if (!isDbUp) {
    console.error('❌ Failed to connect to PostgreSQL. Please check database connection.');
    process.exit(1);
  }
  await runMigrations();

  // 2. Verify Redis & load atomic Lua scripts
  const isRedisUp = await checkRedisHealth();
  if (!isRedisUp) {
    console.error('❌ Failed to connect to Redis. Please check Redis connection.');
    process.exit(1);
  }
  await initRedisScripts();

  // 3. Initialize background BullMQ expiration worker
  const expiryWorker = createExpiryWorker();
  console.log('👷 Reservation Expiry Sweeper Worker started in-process.');

  // 4. Start HTTP Server
  const app = buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  console.log(`⚡ API server successfully listening on http://${env.HOST}:${env.PORT}`);
  console.log(`📌 Health check available at: http://${env.HOST}:${env.PORT}/health`);

  // Graceful Shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const sig of signals) {
    process.on(sig, async () => {
      console.log(`\n🛑 Received ${sig}, initiating graceful shutdown...`);

      try {
        console.log('Closing HTTP server...');
        await app.close();

        console.log('Stopping expiry worker...');
        await expiryWorker.close();

        console.log('Closing BullMQ queue...');
        await expiryQueue.close();

        console.log('Closing Redis connections...');
        await closeRedis();

        console.log('Closing PostgreSQL pool...');
        await closeDbPool();

        console.log('✅ Graceful shutdown completed.');
        process.exit(0);
      } catch (err) {
        console.error('❌ Error during graceful shutdown:', err);
        process.exit(1);
      }
    });
  }
}

bootstrap().catch((err) => {
  console.error('❌ Fatal bootstrap error:', err);
  process.exit(1);
});
