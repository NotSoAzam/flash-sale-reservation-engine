export type TicketStatus = 'AVAILABLE' | 'RESERVED' | 'SOLD';
export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'EXPIRED';
export type OrderStatus = 'PAID' | 'FAILED';

export interface EventRecord {
  id: string;
  title: string;
  total_tickets: number;
  available_tickets: number;
  ticket_price: string | number;
  sale_start_time: Date | string;
  sale_end_time: Date | string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface TicketRecord {
  id: string;
  event_id: string;
  seat_number: string;
  status: TicketStatus;
  version: number;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface ReservationRecord {
  id: string;
  user_id: string;
  event_id: string;
  ticket_ids: string[];
  status: ReservationStatus;
  expires_at: Date | string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface OrderRecord {
  id: string;
  reservation_id: string;
  user_id: string;
  total_amount: string | number;
  idempotency_key: string;
  status: OrderStatus;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export type ReservationStrategy = 'redis_lua' | 'pessimistic_db' | 'optimistic_db';

export interface ReserveTicketInput {
  eventId: string;
  userId: string;
  quantity?: number;
  strategy?: ReservationStrategy;
}

export interface ReserveTicketResult {
  reservationId: string;
  eventId: string;
  userId: string;
  ticketIds: string[];
  status: ReservationStatus;
  expiresAt: string;
  strategyUsed: ReservationStrategy;
}

export interface CheckoutInput {
  reservationId: string;
  userId: string;
  idempotencyKey: string;
  paymentDetails?: {
    paymentMethod?: string;
    token?: string;
  };
}

export interface CheckoutResult {
  orderId: string;
  reservationId: string;
  userId: string;
  totalAmount: number;
  status: OrderStatus;
  idempotencyKey: string;
  cachedResponse?: boolean;
}

export interface RedisReservationPayload {
  id: string;
  userId: string;
  eventId: string;
  ticketIds: string[];
  status: ReservationStatus;
  expiresAt: string;
}
