-- Redis Lua Script: Atomic Ticket Release upon Expiry / Cancellation
-- KEYS[1]: event tickets set (e.g., "event:{eventId}:tickets")
-- KEYS[2]: reservation key (e.g., "reservation:{reservationId}")
-- ARGV[1]: expectedStatus (default 'PENDING')

local ticketsSetKey = KEYS[1]
local reservationKey = KEYS[2]
local expectedStatus = ARGV[1] or 'PENDING'

-- 1. Verify reservation exists
local exists = redis.call('EXISTS', reservationKey)
if exists == 0 then
    return {'ERR_RESERVATION_NOT_FOUND'}
end

-- 2. Verify current status is PENDING (do not rollback if already CONFIRMED)
local currentStatus = redis.call('HGET', reservationKey, 'status')
if currentStatus ~= expectedStatus then
    return {'ERR_INVALID_STATUS', currentStatus}
end

-- 3. Retrieve tickets and return them to the available tickets pool
local ticketsJson = redis.call('HGET', reservationKey, 'ticketIds')
if not ticketsJson then
    return {'ERR_NO_TICKETS'}
end

local tickets = cjson.decode(ticketsJson)
for i = 1, #tickets do
    redis.call('SADD', ticketsSetKey, tickets[i])
end

-- 4. Mark reservation as EXPIRED in Redis
redis.call('HSET', reservationKey, 'status', 'EXPIRED')

return {'OK', ticketsJson}
