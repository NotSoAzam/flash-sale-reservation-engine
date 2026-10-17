-- Redis Lua Script: Atomic Ticket Reservation
-- KEYS[1]: event tickets set (e.g., "event:{eventId}:tickets")
-- KEYS[2]: reservation key (e.g., "reservation:{reservationId}")
-- ARGV[1]: reservationId
-- ARGV[2]: userId
-- ARGV[3]: eventId
-- ARGV[4]: requestedQuantity (e.g., 1)
-- ARGV[5]: ttlSeconds (e.g., 300)
-- ARGV[6]: expiresAtIso (ISO string timestamp)

local ticketsSetKey = KEYS[1]
local reservationKey = KEYS[2]

local reservationId = ARGV[1]
local userId = ARGV[2]
local eventId = ARGV[3]
local quantity = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local expiresAt = ARGV[6]

-- 1. Check current available stock in set
local currentStock = redis.call('SCARD', ticketsSetKey)
if currentStock < quantity then
    return {'ERR_SOLD_OUT', tostring(currentStock)}
end

-- 2. Atomically pop the requested number of tickets from available set
local poppedTickets = redis.call('SPOP', ticketsSetKey, quantity)
if type(poppedTickets) == 'string' then
    poppedTickets = { poppedTickets }
end

-- If SPOP returned fewer than requested (defensive check)
if #poppedTickets < quantity then
    -- Rollback popped tickets back into the set
    for i = 1, #poppedTickets do
        redis.call('SADD', ticketsSetKey, poppedTickets[i])
    end
    return {'ERR_INSUFFICIENT_STOCK', tostring(#poppedTickets)}
end

-- 3. Record reservation in Redis with TTL
local ticketsJson = cjson.encode(poppedTickets)
redis.call('HMSET', reservationKey,
    'id', reservationId,
    'userId', userId,
    'eventId', eventId,
    'ticketIds', ticketsJson,
    'status', 'PENDING',
    'expiresAt', expiresAt
)
redis.call('EXPIRE', reservationKey, ttl)

-- 4. Return success and the reserved ticket IDs
return {'OK', ticketsJson}
