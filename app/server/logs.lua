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
