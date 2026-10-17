import { pool } from './index.js';
import { runMigrations } from './migrate.js';
import { initRedisScripts } from '../redis/scripts.js';
import { eventService } from '../services/event.service.js';
import { closeRedis } from '../redis/index.js';

async function seed() {
  console.log('🌱 Starting Database and Redis Seeding...');

  // Ensure migrations are up to date
  await runMigrations();
  await initRedisScripts();

  // Create primary flash sale test event with 100 tickets
  const flashSaleEvent = await eventService.createEvent({
    title: 'Coldplay Music of the Spheres - Flash Sale 2026',
    totalTickets: 100,
    ticketPrice: 75.0,
    saleStartTime: new Date(),
    saleEndTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log('🎉 Flash sale event seeded successfully!');
  console.log(`🎟️ Event ID: ${flashSaleEvent.event.id}`);
  console.log(`🎫 Total Tickets: ${flashSaleEvent.ticketCount}`);
  console.log(`💲 Price per ticket: $${flashSaleEvent.event.ticket_price}`);

  // Also create a smaller event specifically for concurrency stress test (20 tickets)
  const stressTestEvent = await eventService.createEvent({
    title: 'VIP Exclusive Lounge - Concurrency Stress Test',
    totalTickets: 20,
    ticketPrice: 150.0,
    saleStartTime: new Date(),
    saleEndTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log('\n🔥 Stress test event seeded successfully!');
  console.log(`🎟️ Stress Event ID: ${stressTestEvent.event.id}`);
  console.log(`🎫 Total Tickets: ${stressTestEvent.ticketCount}`);

  await pool.end();
  await closeRedis();
  console.log('✨ Seeding complete.');
}

seed().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
