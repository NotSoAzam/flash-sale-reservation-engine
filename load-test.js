import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const successfulReservations = new Counter('successful_reservations');
const soldOutConflicts = new Counter('sold_out_conflicts');
const serverErrors = new Counter('server_errors');
const reservationLatency = new Trend('reservation_latency_ms', true);
const checkoutLatency = new Trend('checkout_latency_ms', true);
const successRate = new Rate('reservation_success_rate');

export const options = {
  scenarios: {
    flash_sale_spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 200 },   // Warm-up ramp
        { duration: '20s', target: 1000 },  // High load spike
        { duration: '30s', target: 2000 },  // Peak 2,000 Concurrent Virtual Users
        { duration: '15s', target: 500 },   // Gradual ramp-down
        { duration: '10s', target: 0 },     // Cool down
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // Assert p95 < 150ms and p99 < 300ms under high load
    'http_req_duration': ['p(95)<150', 'p(99)<300'],
    'reservation_latency_ms': ['p(95)<100', 'p(99)<250'],
    'server_errors': ['count<1'], // Zero 5xx server crashes permitted
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const EVENT_ID = __ENV.EVENT_ID || '00000000-0000-0000-0000-000000000000';

export function setup() {
  console.log(`🚀 Setting up k6 Flash Sale Load Test against ${BASE_URL}...`);

  // If no EVENT_ID passed, create a fresh flash sale event with 1,000 tickets
  if (EVENT_ID === '00000000-0000-0000-0000-000000000000') {
    const payload = JSON.stringify({
      title: `k6 Load Test Event - ${Date.now()}`,
      totalTickets: 1000,
      ticketPrice: 50.0,
    });

    const res = http.post(`${BASE_URL}/api/v1/events`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (res.status === 201) {
      const data = JSON.parse(res.body).data;
      console.log(`✅ Created test event: ${data.event.id} with ${data.ticketCount} tickets.`);
      return { eventId: data.event.id };
    } else {
      console.error(`Failed to setup test event. Status: ${res.status}`);
      return { eventId: null };
    }
  }

  return { eventId: EVENT_ID };
}

export default function (data) {
  const eventId = data.eventId;
  if (!eventId) {
    sleep(1);
    return;
  }

  const userId = `vu-user-${__VU}-${__ITER}-${Date.now()}`;
  const reservePayload = JSON.stringify({
    userId,
    quantity: 1,
    strategy: 'redis_lua', // Default high-concurrency Redis Lua
  });

  const reserveStartTime = Date.now();
  const res = http.post(`${BASE_URL}/api/v1/events/${eventId}/reserve`, reservePayload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'ReserveTicket' },
  });
  reservationLatency.add(Date.now() - reserveStartTime);

  if (res.status === 201) {
    successfulReservations.add(1);
    successRate.add(1);

    const body = JSON.parse(res.body);
    const reservationId = body.data?.reservationId;

    check(res, {
      'reservation status is 201': (r) => r.status === 201,
      'has reservationId': () => !!reservationId,
    });

    // Simulate immediate checkout for successful reservations
    if (reservationId) {
      const idempotencyKey = `idemp-${userId}-${reservationId}`;
      const checkoutPayload = JSON.stringify({
        reservationId,
        userId,
      });

      const checkoutStartTime = Date.now();
      const checkoutRes = http.post(`${BASE_URL}/api/v1/orders/checkout`, checkoutPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        tags: { name: 'CheckoutOrder' },
      });
      checkoutLatency.add(Date.now() - checkoutStartTime);

      check(checkoutRes, {
        'checkout status is 201 or 200': (r) => r.status === 201 || r.status === 200,
        'order status is PAID': (r) => {
          try {
            return JSON.parse(r.body).data?.status === 'PAID';
          } catch {
            return false;
          }
        },
      });
    }
  } else if (res.status === 409) {
    soldOutConflicts.add(1);
    successRate.add(0);

    check(res, {
      'expected sold-out conflict 409': (r) => r.status === 409,
    });
  } else {
    serverErrors.add(1);
    console.error(`Unexpected HTTP ${res.status}: ${res.body}`);
  }

  // Small random sleep between 10ms - 50ms to simulate real user network latency
  sleep(Math.random() * 0.04 + 0.01);
}

export function teardown(data) {
  console.log(`🏁 Load test complete for Event: ${data.eventId}`);
}
