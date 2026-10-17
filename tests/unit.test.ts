import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runUnitTests() {
  console.log('🧪 ========================================================');
  console.log('🧪 UNIT & CONTRACT INTEGRATION TESTS');
  console.log('🧪 ========================================================\n');

  // Test 1: Fastify App Factory & Route Registration
  console.log('1️⃣ Testing Fastify App Factory and Routing...');
  const app = buildApp();
  await app.ready();
  assert.ok(app, 'Fastify application must initialize successfully');
  console.log('✅ Fastify app booted successfully with all registered routes.');

  // Test 2: Health Check API Contract
  console.log('2️⃣ Testing Health Check API Contract (/health)...');
  const healthRes = await app.inject({
    method: 'GET',
    url: '/health',
  });
  // Since Redis/Postgres may not be connected yet in unit mode, status should return 200 (if up) or 503 (if down/degraded)
  assert.ok(
    healthRes.statusCode === 200 || healthRes.statusCode === 503,
    `Health check must return 200 or 503, got ${healthRes.statusCode}`
  );
  const healthData = JSON.parse(healthRes.body);
  assert.ok('services' in healthData, 'Health response must contain services status');
  assert.ok('database' in healthData.services, 'Health response must check database');
  assert.ok('redis' in healthData.services, 'Health response must check redis');
  console.log(`✅ Health check responded with proper schema (status: ${healthData.status}).`);

  // Test 3: Checkout Endpoint Validation (Missing Idempotency-Key)
  console.log('3️⃣ Testing Idempotency-Key Header Enforcement on Checkout...');
  const checkoutMissingKeyRes = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/checkout',
    payload: {
      reservationId: 'some-res-id',
      userId: 'some-user-id',
    },
  });
  assert.strictEqual(
    checkoutMissingKeyRes.statusCode,
    400,
    'Checkout without Idempotency-Key must return HTTP 400 Bad Request'
  );
  const checkoutMissingKeyBody = JSON.parse(checkoutMissingKeyRes.body);
  assert.ok(
    checkoutMissingKeyBody.message.includes('Idempotency-Key'),
    'Error message must indicate missing Idempotency-Key'
  );
  console.log('✅ Idempotency-Key header is strictly enforced.');

  // Test 4: Checkout Endpoint Validation (Missing Body fields)
  console.log('4️⃣ Testing Checkout Payload Validation...');
  const checkoutMissingBodyRes = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/checkout',
    headers: {
      'Idempotency-Key': 'test-key-12345',
    },
    payload: {},
  });
  assert.strictEqual(
    checkoutMissingBodyRes.statusCode,
    400,
    'Checkout with missing body fields must return HTTP 400 Bad Request'
  );
  console.log('✅ Checkout body payload validation passed.');

  // Test 5: Event Creation Validation (Invalid parameters)
  console.log('5️⃣ Testing Event Creation Validation...');
  const eventInvalidRes = await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    payload: {
      title: '',
      totalTickets: 0,
    },
  });
  assert.strictEqual(
    eventInvalidRes.statusCode,
    400,
    'Creating event with zero tickets or empty title must return HTTP 400'
  );
  console.log('✅ Event input validation passed.');

  // Test 6: Verify Redis Lua Scripts Integrity & Syntax Structure
  console.log('6️⃣ Verifying Redis Lua Scripts Integrity on Disk...');
  const luaDir = path.join(__dirname, '..', 'src', 'redis', 'lua');
  const reserveLuaPath = path.join(luaDir, 'reserve_ticket.lua');
  const releaseLuaPath = path.join(luaDir, 'release_ticket.lua');

  assert.ok(fs.existsSync(reserveLuaPath), 'reserve_ticket.lua must exist');
  assert.ok(fs.existsSync(releaseLuaPath), 'release_ticket.lua must exist');

  const reserveLuaContent = fs.readFileSync(reserveLuaPath, 'utf-8');
  const releaseLuaContent = fs.readFileSync(releaseLuaPath, 'utf-8');

  // Verify critical Lua commands and keywords exist
  assert.ok(reserveLuaContent.includes('redis.call(\'SCARD\''), 'reserve_ticket.lua must call SCARD');
  assert.ok(reserveLuaContent.includes('redis.call(\'SPOP\''), 'reserve_ticket.lua must call SPOP');
  assert.ok(reserveLuaContent.includes('cjson.encode'), 'reserve_ticket.lua must use cjson.encode');
  assert.ok(reserveLuaContent.includes('redis.call(\'EXPIRE\''), 'reserve_ticket.lua must call EXPIRE');

  assert.ok(releaseLuaContent.includes('redis.call(\'SADD\''), 'release_ticket.lua must call SADD');
  assert.ok(releaseLuaContent.includes('cjson.decode'), 'release_ticket.lua must use cjson.decode');

  console.log('✅ Redis Lua scripts verified for required atomic primitives.');

  // Teardown
  await app.close();
  try {
    const { redis } = await import('../src/redis/index.js');
    redis.disconnect();
    const { closeDbPool } = await import('../src/db/index.js');
    await closeDbPool();
  } catch {}

  console.log('\n🎉 ========================================================');
  console.log('🎉 ALL UNIT & CONTRACT TESTS PASSED SUCCESSFULLY!');
  console.log('🎉 ========================================================\n');
  process.exit(0);
}

runUnitTests().catch((err) => {
  console.error('❌ Unit test suite failed:', err);
  process.exit(1);
});
