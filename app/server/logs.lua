#!lua name=logs
-- Redis Function library backing redis_log.py's durable log/telemetry store.
--
-- Schema (see redis_log.py's module docstring for the full picture):
--   cttc:log:<entity_id>  hash   field = timestamp (ms, as a string)
--                                value = orjson-encoded record
--   cttc:idx:<entity_id>  zset   member = same timestamp-string field name
--                                score  = the same timestamp, as a number
--
-- One hash+zset pair per container/host (entity_id), not one hash shared
-- across everything -- keeps a lookup bounded to that entity's own history
-- instead of an O(total 3-day history) scan. The zset is what makes range
-- queries (what /series and /logs actually need) an indexed ZRANGEBYSCORE
-- instead of a full HKEYS scan.

local function getRange(keys, args)
    local hashKey = args[1]
    local zsetKey = args[2]
    local fromTs = args[3]
    local toTs = args[4]

    local fields = redis.call('ZRANGEBYSCORE', zsetKey, fromTs, toTs)
    if #fields == 0 then
        return {}
    end
    return redis.call('HMGET', hashKey, unpack(fields))
end

redis.register_function('getRange', getRange)

-- reconcileTTL: startup-only retention reconciliation (br-REDIS-020, see
-- redis_log.py's RedisLog.reconcile_ttl) -- called once per HSCAN cursor
-- batch, one entity at a time, from Python. args:
--   args[1] hashKey    cttc:log:<entity_id>
--   args[2] zsetKey    cttc:idx:<entity_id>
--   args[3] cursor     HSCAN cursor to resume from ("0" to start)
--   args[4] ttlSeconds the newly-configured sTTL, whole seconds
--   args[5] nowMs      a single "now" snapshot (ms), held constant across
--                       the whole multi-batch/multi-entity reconciliation
--                       pass, so every field is judged against the same
--                       instant rather than a slightly-later "now" the
--                       longer the sweep runs.
--
-- Every field name IS its creation timestamp (ms) -- no separate "created
-- at" to look up (see this file's own schema comment above). For each
-- field in this one HSCAN batch: if `created + ttlSeconds*1000 - nowMs`
-- still leaves at least a whole second, HEXPIRE it to exactly that many
-- remaining seconds (so it still expires at the *original* new-retention
-- boundary, not `ttlSeconds` from right now); otherwise the new, shorter
-- retention means it's already effectively expired, so HDEL the field and
-- ZREM its matching zset member together, in the same atomic call --
-- unlike the passive HEXPIRE-only path elsewhere (whose zset/hash desync
-- the read paths merely tolerate), this never leaves the pair to drift
-- apart as a *direct* result of this function.
--
-- NOVALUES (Redis 7.4+, same release this store already requires for
-- HEXPIRE/HTTL, see the Dockerfile's redis:7.4-alpine pin) skips
-- transferring every record's full JSON payload across the Lua boundary
-- just to discard it -- only field names (timestamps) are ever needed
-- here.
--
-- Returns {nextCursor, keptCount, deletedCount}; nextCursor "0" means this
-- entity's scan is done.
local function reconcileTTL(keys, args)
    local hashKey = args[1]
    local zsetKey = args[2]
    local cursor = args[3]
    local ttlSeconds = tonumber(args[4])
    local nowMs = tonumber(args[5])

    local scanResult = redis.call('HSCAN', hashKey, cursor, 'COUNT', 200, 'NOVALUES')
    local nextCursor = scanResult[1]
    local fields = scanResult[2]

    local keptCount = 0
    local deletedCount = 0
    local toDelete = {}

    for i = 1, #fields do
        local field = fields[i]
        local createdMs = tonumber(field)
        if createdMs then
            local remainingMs = createdMs + (ttlSeconds * 1000) - nowMs
            if remainingMs >= 1000 then
                -- br-REDIS-013's own reasoning applies here too: never let
                -- a HEXPIRE truncate to 0 (Redis treats that as "expire
                -- right now") -- the floor is safe precisely because the
                -- branch above already guarantees remainingMs >= 1000.
                local remainingSeconds = math.floor(remainingMs / 1000)
                redis.call('HEXPIRE', hashKey, remainingSeconds, 'FIELDS', 1, field)
                keptCount = keptCount + 1
            else
                table.insert(toDelete, field)
            end
        end
    end

    if #toDelete > 0 then
        redis.call('HDEL', hashKey, unpack(toDelete))
        redis.call('ZREM', zsetKey, unpack(toDelete))
        deletedCount = #toDelete
    end

    return {nextCursor, keptCount, deletedCount}
end

redis.register_function('reconcileTTL', reconcileTTL)
