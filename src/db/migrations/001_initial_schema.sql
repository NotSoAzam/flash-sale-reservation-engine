-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Events Table
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    total_tickets INTEGER NOT NULL CHECK (total_tickets >= 0),
    available_tickets INTEGER NOT NULL CHECK (available_tickets >= 0),
    ticket_price NUMERIC(10, 2) NOT NULL DEFAULT 50.00,
    sale_start_time TIMESTAMPTZ NOT NULL,
    sale_end_time TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tickets Table
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    seat_number VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'RESERVED', 'SOLD')),
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_event_seat UNIQUE (event_id, seat_number)
);

-- 3. Reservations Table
CREATE TABLE IF NOT EXISTS reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    ticket_ids UUID[] NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL REFERENCES reservations(id),
    user_id UUID NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for High-Concurrency Performance
-- Crucial for PostgreSQL pessimistic locking (FOR UPDATE SKIP LOCKED) to avoid full table scans:
CREATE INDEX IF NOT EXISTS idx_tickets_event_status ON tickets(event_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_event_status_id ON tickets(event_id, status, id);

-- Index for rapid idempotency verification
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders(idempotency_key);

-- Indexes for reservation lookups and sweep worker checks
CREATE INDEX IF NOT EXISTS idx_reservations_event_user ON reservations(event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status_expires ON reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_reservation_id ON orders(reservation_id);
