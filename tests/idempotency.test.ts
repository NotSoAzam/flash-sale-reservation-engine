import assert from 'node:assert';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/app.js';
import { pool, query } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeRedis } from '../src/redis/index.js';
import { initRedisScripts } from '../src/redis/scripts.js';
import { eventService } from '../src/services/event.service.js';
import { expiryQueue } from '../src/queues/queue.js';

async function runIdempotencyTest() {
  console.log('🧪 ========================================================');
  console.log('🧪 IDEMPOTENT CHECKOUT & SETTLEMENT TEST');
  console.log('🧪 ========================================================\n');

  await runMigrations();
  await initRedisScripts();

  const app = buildApp();
  await app.ready();

  // 1. Create an event and reserve 1 ticket
  const { event } = await eventService.createEvent({
    title: 'Idempotency Validation Event',
    totalTickets: 5,
    ticketPrice: 50.0,
  });

  const userId = uuidv4();
  const reserveRes = await app.inject({
    method: 'POST',
    url: `/api/v1/events/${event.id}/reserve`,
    payload: {
      userId,
      quantity: 1,
    },
  });

  assert.strictEqual(reserveRes.statusCode, 201);
  const reservation = JSON.parse(reserveRes.body).data;
  const reservationId = reservation.reservationId;
  console.log(`✅ Reservation created: ${reservationId}`);

  // 2. Perform Checkout with a unique Idempotency-Key
  const idempotencyKey = `idemp-${uuidv4()}`;
  console.log(`🔑 Testing checkout with Idempotency-Key: ${idempotencyKey}`);

  const checkout1 = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/checkout',
    headers: {
      'Idempotency-Key': idempotencyKey,
    },
    payload: {
      reservationId,
      userId,
    },
  });

  assert.strictEqual(checkout1.statusCode, 201);
  const checkout1Data = JSON.parse(checkout1.body).data;
  console.log(`✅ First checkout succeeded with Order ID: ${checkout1Data.orderId}`);

  // 3. Fire immediate identical retry with the SAME Idempotency-Key
  console.log(`🔁 Repeating request with the exact same Idempotency-Key (simulating network timeout retry)...`);
  const checkout2 = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/checkout',
    headers: {
      'Idempotency-Key': idempotencyKey,
    },
    payload: {
      reservationId,
      userId,
    },
  });

  assert.strictEqual(checkout2.statusCode, 200, 'Retry must return 200 OK');
  const checkout2Data = JSON.parse(checkout2.body).data;

  // 4. Assert response equality and zero duplicate order creation
  assert.strictEqual(
    checkout2Data.orderId,
    checkout1Data.orderId,
    'Cached order ID must match initial order ID'
  );
  assert.strictEqual(
    checkout2Data.cachedResponse,
    true,
    'Second response must have cachedResponse = true'
  );

  // 5. Query PostgreSQL database directly to verify exactly 1 order exists
  const orderCountRes = await query(
    'SELECT count(*) FROM orders WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  const orderCount = parseInt(orderCountRes.rows[0].count, 10);
  assert.strictEqual(orderCount, 1, 'Database must contain exactly 1 order for this idempotency key');

  // Verify reservation is CONFIRMED and ticket is SOLD
  const resRecord = await query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
  assert.strictEqual(resRecord.rows[0].status, 'CONFIRMED');

  const ticketRecord = await query('SELECT status FROM tickets WHERE id = $1', [reservation.ticketIds[0]]);
  assert.strictEqual(ticketRecord.rows[0].status, 'SOLD');

  console.log('✅ Zero duplicate orders in DB. Statuses correctly transitioned to CONFIRMED and SOLD.');

  console.log('\n🎉 ========================================================');
  console.log('🎉 IDEMPOTENCY TEST PASSED WITH ZERO DUPLICATE SETTLEMENTS!');
  console.log('🎉 ========================================================\n');

  await app.close();
  await expiryQueue.close();
  await closeRedis();
  await pool.end();
}

runIdempotencyTest().catch((err) => {
  console.error('❌ Idempotency test failed:', err);
  process.exit(1);
});
