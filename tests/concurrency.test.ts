import assert from 'node:assert';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/app.js';
import { pool, query } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { redis, closeRedis } from '../src/redis/index.js';
import { initRedisScripts } from '../src/redis/scripts.js';
import { eventService } from '../src/services/event.service.js';
import { expiryQueue } from '../src/queues/queue.js';

async function runConcurrencyStressTest() {
  console.log('🧪 ========================================================');
  console.log('🧪 HIGH-CONCURRENCY RESERVATION STRESS TEST (500 Requests -> 20 Tickets)');
  console.log('🧪 ========================================================\n');

  // Setup DB & Redis
  await runMigrations();
  await initRedisScripts();

  const app = buildApp();
  await app.ready();

  // 1. Create a fresh test event with strictly 20 tickets
  console.log('1️⃣ Creating test event with exactly 20 available tickets...');
  const { event } = await eventService.createEvent({
    title: `Stress Test Event - ${Date.now()}`,
    totalTickets: 20,
    ticketPrice: 100.0,
  });
  const eventId = event.id;

  // Verify initial state
  const initialStock = await redis.scard(`event:${eventId}:tickets`);
  assert.strictEqual(initialStock, 20, 'Initial Redis ticket stock must be 20');
  console.log(`✅ Event ${eventId} initialized with 20 tickets in PostgreSQL and Redis.\n`);

  // 2. Prepare 500 concurrent reservation requests
  const TOTAL_REQUESTS = 500;
  console.log(`2️⃣ Firing ${TOTAL_REQUESTS} parallel asynchronous requests at the exact same millisecond...`);
  const startTime = Date.now();

  const requests = Array.from({ length: TOTAL_REQUESTS }, (_, i) => {
    const userId = uuidv4();
    return app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/reserve`,
      payload: {
        userId,
        quantity: 1,
        strategy: 'redis_lua',
      },
    });
  });

  const responses = await Promise.all(requests);
  const totalDuration = Date.now() - startTime;

  console.log(`⏱️ Completed ${TOTAL_REQUESTS} requests in ${totalDuration}ms (~${((TOTAL_REQUESTS / totalDuration) * 1000).toFixed(0)} RPS).\n`);

  // 3. Analyze HTTP Responses
  const successfulResponses: any[] = [];
  const conflictResponses: any[] = [];
  const otherResponses: any[] = [];

  for (const res of responses) {
    const body = JSON.parse(res.body);
    if (res.statusCode === 201) {
      successfulResponses.push(body);
    } else if (res.statusCode === 409) {
      conflictResponses.push(body);
    } else {
      otherResponses.push({ status: res.statusCode, body });
    }
  }

  console.log('📊 Result Distribution:');
  console.log(`   - HTTP 201 Created (Success):       ${successfulResponses.length}`);
  console.log(`   - HTTP 409 Conflict (Sold Out):     ${conflictResponses.length}`);
  console.log(`   - Other / Errors:                   ${otherResponses.length}`);

  // 4. Invariant Assertions
  assert.strictEqual(
    otherResponses.length,
    0,
    `Expected 0 unexpected error responses, but got ${otherResponses.length}: ${JSON.stringify(otherResponses)}`
  );

  assert.strictEqual(
    successfulResponses.length,
    20,
    `CRITICAL INVARIANT VIOLATED: Expected exactly 20 successful reservations, but got ${successfulResponses.length}`
  );

  assert.strictEqual(
    conflictResponses.length,
    480,
    `CRITICAL INVARIANT VIOLATED: Expected exactly 480 sold-out conflicts, but got ${conflictResponses.length}`
  );

  // 5. Verify Zero Double-Allocations
  const allocatedTicketIds = successfulResponses.flatMap((r) => r.data.ticketIds);
  const uniqueAllocatedTicketIds = new Set(allocatedTicketIds);

  assert.strictEqual(
    allocatedTicketIds.length,
    20,
    'Total reserved tickets across all success responses must be 20'
  );
  assert.strictEqual(
    uniqueAllocatedTicketIds.size,
    20,
    `ZERO OVERSOLD GUARANTEE FAILED: Found duplicate ticket allocations! Unique: ${uniqueAllocatedTicketIds.size}, Total: ${allocatedTicketIds.length}`
  );

  console.log('✅ Invariant Verified: Zero duplicate ticket allocations.');

  // 6. Verify Database Invariants
  console.log('3️⃣ Verifying PostgreSQL database state invariants...');
  const reservedTicketsDb = await query(
    `SELECT count(*) FROM tickets WHERE event_id = $1 AND status = 'RESERVED'`,
    [eventId]
  );
  assert.strictEqual(
    parseInt(reservedTicketsDb.rows[0].count, 10),
    20,
    'DB tickets with status RESERVED must be 20'
  );

  const availableTicketsDb = await query(
    `SELECT count(*) FROM tickets WHERE event_id = $1 AND status = 'AVAILABLE'`,
    [eventId]
  );
  assert.strictEqual(
    parseInt(availableTicketsDb.rows[0].count, 10),
    0,
    'DB tickets with status AVAILABLE must be 0'
  );

  const eventDb = await query(
    `SELECT available_tickets FROM events WHERE id = $1`,
    [eventId]
  );
  assert.strictEqual(
    eventDb.rows[0].available_tickets,
    0,
    'Event available_tickets count in DB must be 0'
  );

  const redisRemainingStock = await redis.scard(`event:${eventId}:tickets`);
  assert.strictEqual(
    redisRemainingStock,
    0,
    'Redis available tickets set must be 0'
  );

  console.log('✅ PostgreSQL & Redis Invariants fully satisfied: Exactly 20 reserved, 0 available, 0 double allocations.');

  console.log('\n🎉 ========================================================');
  console.log('🎉 ALL 500-CONCURRENCY INVARIANTS PASSED PERFECTLY!');
  console.log('🎉 ========================================================\n');

  // Teardown
  await app.close();
  await expiryQueue.close();
  await closeRedis();
  await pool.end();
}

runConcurrencyStressTest().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
