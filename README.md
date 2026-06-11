# Red Bucket

**Red Bucket** is an implementation of the [**token bucket**](https://en.wikipedia.org/wiki/Token_bucket) algorithm using **Redis** as storage for the buckets.

The **token bucket algorithm** is used for rate limiting, like when you want to rate limit an endpoint of your API:

```ts
import { initialize, createBucket } from "red-bucket";

// At your app's startup
const redisClientPool = (await createClientPool({
  url: process.env.REDIS_URL,
}).connect())!;

// First we initialize the lib with **your** Redis client.
await initialize(redisClientPool);

// At some controller of yours
app.get("/users", async (request, reply) => {
  const bucket = createBucket({
    // Some unique ID
    id: `USERS_ENDPOINT_${request.ip}`,
    capacity: 200,
    // Refills 60 tokens every minute
    refillPolicy: {
      tokens: 60,
      intervalInMilliseconds: 60_000,
    },
  });

  const { success } = await bucket.safeConsume(1);

  if (!success) {
    return reply.status(429).send("Too many requests!");
  }

  const users = await getUsers();

  return reply.status(200).send(users);
});
```

## API

### `initialize()`

Initializes the lib with **your** Redis client or client pool. It **must** be called before calling `createBucket`.

Usage:

```ts
// At your app's startup
const redisClient = (await createClient({
  url: process.env.REDIS_URL,
}).connect())!;

await initialize(redisClient);
```

Besides storing a reference to your Redis client/pool, this function also sets up the necessary lua scripts in Redis.

#### Parameters

- `redisClientOrPool: RedisClientOrPool`: Either a Redis client (created with `createClient`) or a Redis client pool (created with `createClientPool`).

#### Returns

A `Promise<void>`.

### `createBucket()`

Creates a token bucket.

The bucket that is returned by this function is **stateless**, in the sense that all state is stored in Redis, so in practice the bucket object acts more like a client. Because of that, it's okay and even expected for you to (re-)create a bucket every time you need to access the underlying bucket stored in Redis.

Note: For optimization reasons, calling this function **does not** cause the bucket to be stored in Redis, which in practice does not affect the algorithm per se.

#### Parameters

- `id: string` -> An id that **uniquely** identifies your bucket. You may compose this id by concatenating the operation name with the user's identifier (ip for anonymous users and the user's id for authenticated ones).
- `capacity: number` -> The maximum amount of tokens the bucket can hold.
- `refillPolicy: { tokens: number; intervalInMilliseconds: number }` -> How many `tokens` get replenished every `intervalInMilliseconds`.

Refilling is **continuous**: tokens are replenished smoothly (including fractional amounts) rather than landing in chunks at each interval, so `{ tokens: 5, intervalInMilliseconds: 10_000 }` is equivalent to `{ tokens: 1, intervalInMilliseconds: 2_000 }` — the two fields are just a readable way of expressing a rate.

Throws if `capacity`, `refillPolicy.tokens` or `refillPolicy.intervalInMilliseconds` are not positive numbers.

#### Returns

A `Bucket` object.

### `bucket.getId()`

Returns the bucket id.

### `bucket.getCapacity()`

Returns the bucket capacity.

### `bucket.getRefillPolicy()`

Returns the bucket refill policy (`{ tokens, intervalInMilliseconds }`).

### `bucket.consume()`

Tries to consume a given amount of tokens from the bucket.

If there are enough tokens, it updates the bucket by consuming the tokens.

If there are **not** enough tokens, it throws a `TokenBucketError` with `NOT_ENOUGH_TOKENS` reason.

Usage:

```ts
// At some controller of yours
app.get("/users", async (request, reply) => {
  const bucket = createBucket({
    id: `USERS_ENDPOINT_${request.ip}`,
    capacity: 200,
    refillPolicy: {
      tokens: 60,
      intervalInMilliseconds: 60_000,
    },
  });

  try {
    await bucket.consume();

    return reply.status(200).send("OK");
  } catch (error) {
    if (isTokenBucketError(error) && error.reason === "NOT_ENOUGH_TOKENS") {
      return reply.status(429).send("Too many requests");
    }

    throw error;
  }
});
```

#### Parameters

- `amount?: number` -> Specifies the amount of tokens to be consumed. Defaults to 1 token.

#### Returns

An object `{ availableTokens: number }` where `availableTokens` is the number of **remaining tokens** in the bucket.

### `bucket.safeConsume()`

Same as `bucket.consume()`, but it never throws and returns a result object instead.

Usage:

```ts
// At some controller of yours
app.get("/users", async (request, reply) => {
  const bucket = createBucket({
    id: `USERS_ENDPOINT_${request.ip}`,
    capacity: 200,
    refillPolicy: {
      tokens: 60,
      intervalInMilliseconds: 60_000,
    },
  });

  const { success } = await bucket.safeConsume(1);

  if (!success) {
    return reply.status(429).send("Too many requests!");
  }

  const users = await getUsers();

  return reply.status(200).send(users);
});
```

#### Parameters

- `amount?: number` -> Specifies the amount of tokens to be consumed. Defaults to 1 token.

#### Returns

- `result`
  - `success: boolean` -> Whether the bucket had enough tokens to be consumed.
  - `availableTokens: number` -> The number of tokens remaining.
  - `error?: TokenBucketError` -> The corresponding `TokenBucketError` when there are not enough tokens.
  - `timeUntilAvailableInMilliseconds?: number` -> Only present when the consumption **fails**: how long until the bucket holds the attempted amount, which is exactly what you want for a `Retry-After` header. It is `Infinity` when the attempted amount exceeds the bucket capacity (it'd never be reached). Also available on the `error` itself.

The `result` object is a **discriminated** union, which means that when you check for the presence/absence of `error` or the `success` to be true/false, TypeScript is able to **narrow down** the type.

### `bucket.getAvailableTokens()`

Returns the amount of tokens currently in the bucket.

#### Returns

A `Promise<number>`.

### `bucket.getTimeUntilFullInMilliseconds()`

Returns how long until the bucket gets completely refilled, e.g. for populating a `RateLimit-Reset` header.

Returns `0` when the bucket is already full.

#### Returns

A `Promise<number>`.

### `bucket.getTimeUntilAvailableInMilliseconds()`

Returns how long until the bucket holds at least a given amount of tokens.

Returns `0` when the bucket already holds the given amount.

Throws when the given amount exceeds the bucket capacity, as it'd never be reached.

#### Parameters

- `tokens?: number` -> The target amount of tokens. Defaults to 1 token.

#### Returns

A `Promise<number>`.

## Populating rate limiting headers

All the values needed for the standard rate limiting headers are exposed by the bucket:

```ts
app.get("/users", async (request, reply) => {
  const bucket = createBucket({
    id: `USERS_ENDPOINT_${request.ip}`,
    capacity: 200,
    refillPolicy: {
      tokens: 60,
      intervalInMilliseconds: 60_000,
    },
  });

  const result = await bucket.safeConsume(1);

  reply.header("RateLimit-Limit", bucket.getCapacity());
  reply.header("RateLimit-Remaining", Math.floor(result.availableTokens));
  reply.header(
    "RateLimit-Reset",
    Math.ceil((await bucket.getTimeUntilFullInMilliseconds()) / 1000),
  );

  if (!result.success) {
    reply.header(
      "Retry-After",
      Math.ceil(result.timeUntilAvailableInMilliseconds / 1000),
    );

    return reply.status(429).send("Too many requests!");
  }

  const users = await getUsers();

  return reply.status(200).send(users);
});
```

Note that `Retry-After` comes for free from the failed `safeConsume` result — it doesn't cost an extra roundtrip to Redis.

## Migrating from v1

- `refillRateInTokensPerMinute: 60` became `refillPolicy: { tokens: 60, intervalInMilliseconds: 60_000 }`. The refilling behavior itself is unchanged (continuous).
- `bucket.getRefillRate()` became `bucket.getRefillPolicy()` and returns the `refillPolicy` object.
- `bucket.getTokenAmount()` was renamed to `bucket.getAvailableTokens()`.
- The `tokenAmount` field on `consume()`/`safeConsume()` results and on `TokenBucketError` was renamed to `availableTokens`.
- Buckets created by v1 and v2 live under different Redis keys, so both versions can run side by side during a rollout — v1 buckets simply expire on their own.
