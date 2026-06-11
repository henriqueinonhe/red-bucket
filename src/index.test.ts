import { createClientPool } from "@redis/client";
import { describe, it, expect } from "vitest";
import {
  createBucket,
  initialize,
  isTokenBucketError,
  TokenBucketError,
} from "./index.js";
import { libName, libVersion } from "./lib.js";
import type { RedisClientOrPool } from "./client.js";
import { retex } from "return-exception";

describe("Initialization", () => {
  it("Loads lib properly", async () => {
    // Setup
    const redisClientPool = await setupRedisClientPool();

    await ensureLibIsNotLoadedYet(redisClientPool);

    // Act
    await initialize(redisClientPool);

    const result = await redisClientPool.functionList({
      LIBRARYNAME: libName,
    });

    const [first] = result;

    // Assert
    expect(result.length).toBe(1);
    expect(first!.library_name).toBe(libName);

    // Teardown
    await deleteLib(redisClientPool);
  });

  it("Doesn't load the lib if it is already loaded", async () => {
    // Setup
    const redisClientPool = await setupRedisClientPool();

    await ensureLibIsNotLoadedYet(redisClientPool);

    await initialize(redisClientPool);

    // Act && Assert
    expect(() => initialize(redisClientPool)).not.toThrow();

    // Teardown
    await deleteLib(redisClientPool);
  });
});

describe("Bucket", () => {
  it("Methods that return data stored locally (`getId`, `getCapacity`, `getRefillPolicy`) work correctly", async () => {
    // Setup
    await setup();

    // Act
    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    // Assert
    expect(bucket.getId()).toBe("DUBA_DUBA");
    expect(bucket.getCapacity()).toBe(200);
    expect(bucket.getRefillPolicy()).toEqual({
      tokens: 100,
      intervalInMilliseconds: 60_000,
    });
  });

  it("`createBucket` rejects non-positive `capacity`, `refillPolicy.tokens` and `refillPolicy.intervalInMilliseconds`", async () => {
    // Setup
    await setup();

    // Act && Assert
    expect(() =>
      createBucket({
        id: "DUBA_DUBA",
        capacity: 0,
        refillPolicy: { tokens: 100, intervalInMilliseconds: 60_000 },
      }),
    ).toThrow();

    expect(() =>
      createBucket({
        id: "DUBA_DUBA",
        capacity: 200,
        refillPolicy: { tokens: -100, intervalInMilliseconds: 60_000 },
      }),
    ).toThrow();

    expect(() =>
      createBucket({
        id: "DUBA_DUBA",
        capacity: 200,
        refillPolicy: { tokens: 100, intervalInMilliseconds: 0 },
      }),
    ).toThrow();
  });

  it("`getAvailableTokens` works when bucket is not stored in Redis", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    // Act
    const availableTokens = await bucket.getAvailableTokens();

    // Assert
    expect(availableTokens).toBe(200);

    // Teardown
    await teardown(redisClientPool);
  });

  it("`getAvailableTokens` works when bucket IS stored in Redis", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillPolicy = {
      tokens: 100,
      intervalInMilliseconds: 60_000,
    };

    const bucket = createBucket({
      id,
      capacity,
      refillPolicy,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const preExistingTokens = 100;
    const halfAMinuteInMilliseconds = 1000 * 30;
    const lastRefilledAtInMilliseconds = Date.now() - halfAMinuteInMilliseconds;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokens,
      last_refilled_at_in_milliseconds: lastRefilledAtInMilliseconds,
    });

    // Act
    const availableTokens = await bucket.getAvailableTokens();

    // Assert
    expect(availableTokens).toBeCloseTo(150);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`consume` creates bucket in Redis when it doesn't exist and works properly when there are enough tokens", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_DUBA_DUBA`;

    // Act
    const { availableTokens } = await bucket.consume(10);

    // Assert
    const redisBucket = await redisClientPool.hGetAll(key);
    const redisBucketTtl = await redisClientPool.ttl(key);

    const refillRateInTokensPerSecond = 100 / 60;
    const timeToRefillInSeconds = 10 / refillRateInTokensPerSecond;

    const redisBucketTokens = parseFloat(redisBucket.tokens!);
    const redisBucketLastRefilledAt = parseInt(
      redisBucket.last_refilled_at_in_milliseconds!,
    );

    expect(availableTokens).toBe(190);
    expect(redisBucketTokens).toBe(190);
    expect(redisBucketLastRefilledAt).toBeLessThanOrEqual(Date.now());
    expect(Date.now()).toBeLessThanOrEqual(redisBucketLastRefilledAt + 100);
    expect(redisBucketTtl).toBeLessThanOrEqual(timeToRefillInSeconds);
    expect(timeToRefillInSeconds).toBeLessThanOrEqual(redisBucketTtl + 1);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`consume` does NOT create a bucket in Redis when there are not enough tokens and a bucket does not already exists", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    // Act
    const [, error] = await retex(
      () => bucket.consume(201),
      [isTokenBucketError],
    );

    // Assert
    const availableTokens = await bucket.getAvailableTokens();

    expect(error).toBeInstanceOf(TokenBucketError);
    expect(error!.reason).toBe("NOT_ENOUGH_TOKENS");
    expect(availableTokens).toBe(200);

    // Teardown

    await teardown(redisClientPool);
  });

  it("`consume` reuses existing bucket in Redis and works properly when there are enough tokens, refilling first", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillPolicy = {
      tokens: 100,
      intervalInMilliseconds: 60_000,
    };
    const refillRateInTokensPerMillisecond =
      refillPolicy.tokens / refillPolicy.intervalInMilliseconds;
    const refillRateInTokensPerSecond = refillRateInTokensPerMillisecond * 1000;

    const bucket = createBucket({
      id,
      capacity,
      refillPolicy,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const tokensToRefillInThisAccess = 50;
    const lastRefilledAtInMilliseconds =
      Date.now() -
      tokensToRefillInThisAccess / refillRateInTokensPerMillisecond;

    const preExistingTokenAmount = 100;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokenAmount,
      last_refilled_at_in_milliseconds: lastRefilledAtInMilliseconds,
    });

    // Act
    const tokensToConsume = 130;
    const { availableTokens } = await bucket.consume(tokensToConsume);

    // Assert
    const redisBucket = await redisClientPool.hGetAll(key);
    const redisBucketTtl = await redisClientPool.ttl(key);

    const remainingTokens =
      preExistingTokenAmount + tokensToRefillInThisAccess - tokensToConsume;
    const tokensToRefillCompletely = capacity - remainingTokens;
    const timeToRefillInSeconds =
      tokensToRefillCompletely / refillRateInTokensPerSecond;

    const redisBucketTokens = parseFloat(redisBucket.tokens!);
    const redisBucketLastRefilledAt = parseInt(
      redisBucket.last_refilled_at_in_milliseconds!,
    );

    expect(availableTokens).toBeCloseTo(remainingTokens);
    expect(redisBucketTokens).toBeCloseTo(remainingTokens);
    expect(redisBucketLastRefilledAt).toBeLessThanOrEqual(Date.now());
    expect(Date.now()).toBeLessThanOrEqual(redisBucketLastRefilledAt + 100);
    expect(redisBucketTtl).toBeLessThanOrEqual(timeToRefillInSeconds);
    expect(timeToRefillInSeconds).toBeLessThanOrEqual(redisBucketTtl + 1);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`consume` reuses existing bucket in Redis and works properly when there are NOT enough tokens", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillPolicy = {
      tokens: 100,
      intervalInMilliseconds: 60_000,
    };
    const refillRateInTokensPerMillisecond =
      refillPolicy.tokens / refillPolicy.intervalInMilliseconds;
    const refillRateInTokensPerSecond = refillRateInTokensPerMillisecond * 1000;

    const bucket = createBucket({
      id,
      capacity,
      refillPolicy,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const tokensToRefillInThisAccess = 50;
    const lastRefilledAtInMilliseconds =
      Date.now() -
      tokensToRefillInThisAccess / refillRateInTokensPerMillisecond;

    const preExistingTokenAmount = 100;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokenAmount,
      last_refilled_at_in_milliseconds: lastRefilledAtInMilliseconds,
    });

    // Act
    const tokensToConsume = 160;
    const [, error] = await retex(
      () => bucket.consume(tokensToConsume),
      [isTokenBucketError],
    );

    // Assert
    const redisBucket = await redisClientPool.hGetAll(key);
    const redisBucketTtl = await redisClientPool.ttl(key);
    const availableTokens = await bucket.getAvailableTokens();

    const remainingTokens = preExistingTokenAmount + tokensToRefillInThisAccess;
    const tokensToRefillCompletely = capacity - remainingTokens;
    const timeToRefillInSeconds =
      tokensToRefillCompletely / refillRateInTokensPerSecond;

    const redisBucketTokens = parseFloat(redisBucket.tokens!);
    const redisBucketLastRefilledAt = parseInt(
      redisBucket.last_refilled_at_in_milliseconds!,
    );

    expect(error).toBeInstanceOf(TokenBucketError);
    expect(error!.reason).toBe("NOT_ENOUGH_TOKENS");
    expect(availableTokens).toBeCloseTo(remainingTokens);
    expect(redisBucketTokens).toBeCloseTo(remainingTokens);
    expect(redisBucketLastRefilledAt).toBeLessThanOrEqual(Date.now());
    expect(Date.now()).toBeLessThanOrEqual(redisBucketLastRefilledAt + 100);
    expect(redisBucketTtl).toBeLessThanOrEqual(timeToRefillInSeconds);
    expect(timeToRefillInSeconds).toBeLessThanOrEqual(redisBucketTtl + 1);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("Failed `safeConsume` exposes `timeUntilAvailableInMilliseconds` for the attempted amount", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillPolicy = {
      tokens: 100,
      intervalInMilliseconds: 60_000,
    };

    const bucket = createBucket({
      id,
      capacity,
      refillPolicy,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const preExistingTokenAmount = 100;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokenAmount,
      last_refilled_at_in_milliseconds: Date.now(),
    });

    // Act
    const result = await bucket.safeConsume(150);

    // Assert
    // 50 missing tokens at 100 tokens per minute -> ~30 seconds
    expect(result.success).toBe(false);
    expect(result.availableTokens).toBeCloseTo(100, 1);
    expect(result.timeUntilAvailableInMilliseconds).toBeGreaterThan(29_000);
    expect(result.timeUntilAvailableInMilliseconds).toBeLessThanOrEqual(30_100);

    expect(result.error).toBeInstanceOf(TokenBucketError);
    expect(result.error!.reason).toBe("NOT_ENOUGH_TOKENS");
    expect(result.error!.availableTokens).toBe(result.availableTokens);
    expect(result.error!.timeUntilAvailableInMilliseconds).toBe(
      result.timeUntilAvailableInMilliseconds,
    );

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("Failed `safeConsume` exposes `timeUntilAvailableInMilliseconds` as `Infinity` when the attempted amount exceeds the capacity", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    // Act
    const result = await bucket.safeConsume(201);

    // Assert
    expect(result.success).toBe(false);
    expect(result.timeUntilAvailableInMilliseconds).toBe(Infinity);

    // Teardown
    await teardown(redisClientPool);
  });

  it("`getTimeUntilFullInMilliseconds` returns 0 when the bucket is full", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    // Act
    const timeUntilFullInMilliseconds =
      await bucket.getTimeUntilFullInMilliseconds();

    // Assert
    expect(timeUntilFullInMilliseconds).toBe(0);

    // Teardown
    await teardown(redisClientPool);
  });

  it("`getTimeUntilFullInMilliseconds` works when the bucket is partially full", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillPolicy = {
      tokens: 100,
      intervalInMilliseconds: 60_000,
    };

    const bucket = createBucket({
      id,
      capacity,
      refillPolicy,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const preExistingTokenAmount = 100;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokenAmount,
      last_refilled_at_in_milliseconds: Date.now(),
    });

    // Act
    const timeUntilFullInMilliseconds =
      await bucket.getTimeUntilFullInMilliseconds();

    // Assert
    // 100 missing tokens at 100 tokens per minute -> ~1 minute
    expect(timeUntilFullInMilliseconds).toBeGreaterThan(59_000);
    expect(timeUntilFullInMilliseconds).toBeLessThanOrEqual(60_100);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`getTimeUntilAvailableInMilliseconds` returns 0 when there are already enough tokens", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    // Act
    const timeUntilAvailableInMilliseconds =
      await bucket.getTimeUntilAvailableInMilliseconds(50);

    // Assert
    expect(timeUntilAvailableInMilliseconds).toBe(0);

    // Teardown
    await teardown(redisClientPool);
  });

  it("`getTimeUntilAvailableInMilliseconds` works when there are not enough tokens yet", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillPolicy = {
      tokens: 100,
      intervalInMilliseconds: 60_000,
    };

    const bucket = createBucket({
      id,
      capacity,
      refillPolicy,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const preExistingTokenAmount = 100;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokenAmount,
      last_refilled_at_in_milliseconds: Date.now(),
    });

    // Act
    const timeUntilAvailableInMilliseconds =
      await bucket.getTimeUntilAvailableInMilliseconds(150);

    // Assert
    // 50 missing tokens at 100 tokens per minute -> ~30 seconds
    expect(timeUntilAvailableInMilliseconds).toBeGreaterThan(29_000);
    expect(timeUntilAvailableInMilliseconds).toBeLessThanOrEqual(30_100);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`getTimeUntilAvailableInMilliseconds` throws when the target exceeds the bucket capacity", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillPolicy: {
        tokens: 100,
        intervalInMilliseconds: 60_000,
      },
    });

    // Act && Assert
    await expect(
      bucket.getTimeUntilAvailableInMilliseconds(201),
    ).rejects.toThrow();

    // Teardown
    await teardown(redisClientPool);
  });

  const setup = async () => {
    const redisClientPool = await setupRedisClientPool();

    await ensureLibIsNotLoadedYet(redisClientPool);

    await initialize(redisClientPool);

    return { redisClientPool };
  };

  const teardown = async (redisClientPool: RedisClientOrPool) => {
    await deleteLib(redisClientPool);
  };
});

const setupRedisClientPool = async () => {
  return (await createClientPool({
    url: "redis://localhost:6379",
  }).connect())!;
};

const ensureLibIsNotLoadedYet = async (redisClientPool: RedisClientOrPool) => {
  await deleteLib(redisClientPool);
};

const deleteLib = async (redisClientPool: RedisClientOrPool) => {
  await redisClientPool.functionDelete(libName).catch(() => {
    // Ignore error when lib not found!
  });
};
