#!lua name=token_bucket_redis_1_0_9

local function get_now_in_milliseconds()
  local result = redis.call("TIME")

  local seconds = result[1]
  local microseconds_of_second = result[2]

  local milliseconds = (seconds * 1000) + math.floor((microseconds_of_second / 1000))

  return milliseconds
end

local function use_token_bucket(keys, args)
  local bucket_key = keys[1]
  local token_capacity = tonumber(args[1])
  local token_cost = tonumber(args[2])
  local token_refill_rate_in_tokens_per_minute = tonumber(args[3])
  local now_in_milliseconds = get_now_in_milliseconds()

  local bucket = (function()
    local stored_bucket = redis.call("HGETALL", bucket_key)

    if #stored_bucket ~= 0 then
      return stored_bucket
    end

    return {
      "tokens", token_capacity,
      "last_refilled_at_in_milliseconds", now_in_milliseconds
    }
  end)()

  local current_tokens = bucket[2]
  local current_last_refilled_at_in_milliseconds = bucket[4]

  local time_elapsed_in_milliseconds_since_last_refill = 
    now_in_milliseconds - current_last_refilled_at_in_milliseconds

  local token_refill_rate_in_tokens_per_millisecond = 
    token_refill_rate_in_tokens_per_minute / (60 * 1000)

  local tokens_to_refill = 
    token_refill_rate_in_tokens_per_millisecond * time_elapsed_in_milliseconds_since_last_refill

  local tokens_after_refill = math.min(
    current_tokens + tokens_to_refill, 
    token_capacity
  )

  local there_are_enough_tokens = token_cost <= tokens_after_refill

  local updated_tokens = (function()
    if not there_are_enough_tokens then
      return tokens_after_refill
    end

    return tokens_after_refill - token_cost
  end)()

  local updated_last_refilled_at_in_milliseconds = now_in_milliseconds

  local updated_bucket = {
    "tokens", updated_tokens,
    "last_refilled_at_in_milliseconds", updated_last_refilled_at_in_milliseconds
  }

  -- We set the bucket to expire
  -- when it would get completely refilled
  -- AFTER the current usage

  local tokens_to_refill_completely = token_capacity - updated_tokens

  local milliseconds_to_refill_completely = 
    tokens_to_refill_completely / token_refill_rate_in_tokens_per_millisecond

  local seconds_to_refill_completely = 
    milliseconds_to_refill_completely / 1000

  redis.call("HSET", bucket_key, unpack(updated_bucket))
  redis.call("EXPIRE", bucket_key, math.ceil(seconds_to_refill_completely))

  -- We have to convert all floats to strings
  -- otherwise Redis coerces them to integers
  -- and truncates them
  if not there_are_enough_tokens then
    return {"FAIL", tostring(updated_tokens)}
  end

  return {"SUCCESS", tostring(updated_tokens)}
end

redis.register_function(
  "use_token_bucket_1_0_9",
  use_token_bucket
)



