import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { redis } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let reserveScriptSha: string | null = null;
let releaseScriptSha: string | null = null;

const reserveScriptPath = path.join(__dirname, 'lua', 'reserve_ticket.lua');
const releaseScriptPath = path.join(__dirname, 'lua', 'release_ticket.lua');

const reserveScriptContent = fs.readFileSync(reserveScriptPath, 'utf-8');
const releaseScriptContent = fs.readFileSync(releaseScriptPath, 'utf-8');

export async function initRedisScripts(): Promise<void> {
  reserveScriptSha = await redis.script('LOAD', reserveScriptContent) as string;
  releaseScriptSha = await redis.script('LOAD', releaseScriptContent) as string;
  console.log('⚡ Redis Lua scripts pre-loaded successfully into Redis cache.');
}

export interface AtomicReserveParams {
  eventId: string;
  reservationId: string;
  userId: string;
  quantity: number;
  ttlSeconds: number;
  expiresAtIso: string;
}

export type AtomicReserveResult =
  | { success: true; ticketIds: string[] }
  | { success: false; reason: 'SOLD_OUT' | 'INSUFFICIENT_STOCK'; availableStock: number };

export async function executeAtomicReserve(params: AtomicReserveParams): Promise<AtomicReserveResult> {
  const ticketsSetKey = `event:${params.eventId}:tickets`;
  const reservationKey = `reservation:${params.reservationId}`;

  try {
    let rawResult: [string, string];
    if (reserveScriptSha) {
      rawResult = await redis.evalsha(
        reserveScriptSha,
        2,
        ticketsSetKey,
        reservationKey,
        params.reservationId,
        params.userId,
        params.eventId,
        params.quantity.toString(),
        params.ttlSeconds.toString(),
        params.expiresAtIso
      ) as [string, string];
    } else {
      rawResult = await redis.eval(
        reserveScriptContent,
        2,
        ticketsSetKey,
        reservationKey,
        params.reservationId,
        params.userId,
        params.eventId,
        params.quantity.toString(),
        params.ttlSeconds.toString(),
        params.expiresAtIso
      ) as [string, string];
    }

    const [status, data] = rawResult;
    if (status === 'OK') {
      const ticketIds = JSON.parse(data) as string[];
      return { success: true, ticketIds };
    }

    if (status === 'ERR_SOLD_OUT') {
      return { success: false, reason: 'SOLD_OUT', availableStock: Number(data) || 0 };
    }

    return { success: false, reason: 'INSUFFICIENT_STOCK', availableStock: Number(data) || 0 };
  } catch (err: any) {
    if (err.message && err.message.includes('NOSCRIPT')) {
      // Reload SHA and retry
      reserveScriptSha = await redis.script('LOAD', reserveScriptContent) as string;
      return executeAtomicReserve(params);
    }
    throw err;
  }
}

export interface AtomicReleaseParams {
  eventId: string;
  reservationId: string;
}

export type AtomicReleaseResult =
  | { success: true; ticketIds: string[] }
  | { success: false; reason: string };

export async function executeAtomicRelease(params: AtomicReleaseParams): Promise<AtomicReleaseResult> {
  const ticketsSetKey = `event:${params.eventId}:tickets`;
  const reservationKey = `reservation:${params.reservationId}`;

  try {
    let rawResult: [string, string?];
    if (releaseScriptSha) {
      rawResult = await redis.evalsha(
        releaseScriptSha,
        2,
        ticketsSetKey,
        reservationKey,
        'PENDING'
      ) as [string, string?];
    } else {
      rawResult = await redis.eval(
        releaseScriptContent,
        2,
        ticketsSetKey,
        reservationKey,
        'PENDING'
      ) as [string, string?];
    }

    const [status, data] = rawResult;
    if (status === 'OK' && data) {
      const ticketIds = JSON.parse(data) as string[];
      return { success: true, ticketIds };
    }

    return { success: false, reason: status };
  } catch (err: any) {
    if (err.message && err.message.includes('NOSCRIPT')) {
      releaseScriptSha = await redis.script('LOAD', releaseScriptContent) as string;
      return executeAtomicRelease(params);
    }
    throw err;
  }
}
